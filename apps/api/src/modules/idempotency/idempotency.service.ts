import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { idempotencyKeys } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { ZodError } from "zod";

/** A request still marked in progress after this long is treated as abandoned (the server crashed mid-request). */
const STALE_AFTER_MS = 60_000;

export type IdempotentOutcome<T> =
  | { kind: "fresh"; value: T; status: number }
  | { kind: "replayed"; body: unknown; status: number };

type StoredError = { error: { code: string; message: string; fieldErrors: { field: string; message: string }[] } };

/** A 4xx refusal worth remembering: the same request will be refused the same way next time. */
export function asRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error.getStatus() < 500 ? error : null;
  if (error instanceof ZodError) {
    return new ApiError(
      "VALIDATION_ERROR",
      "Request validation failed.",
      400,
      error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    );
  }
  return null;
}

export function requestHash(scope: string, body: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\n")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

/**
 * Runs a write at most once per (organization, key). A retry with the same key and the same request gets the first
 * result back, including a first 4xx refusal. A server error (5xx) frees the key so the device can try again.
 * Keys are scoped to the organization and to the person who sent them, so nobody can replay someone else's result.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async run<T>(
    context: { tenantId: string; membershipId: string },
    key: string,
    scope: string,
    hash: string,
    work: () => Promise<{ value: T; status: number }>,
  ): Promise<IdempotentOutcome<T>> {
    const claimed = await this.claim(context, key, scope, hash);
    if (!claimed) return this.replay(context, key, scope, hash);
    try {
      const { value, status } = await work();
      await this.db
        .update(idempotencyKeys)
        .set({ status: "completed", responseStatus: status, responseBody: value as object, completedAt: new Date() })
        .where(and(eq(idempotencyKeys.tenantId, context.tenantId), eq(idempotencyKeys.key, key)));
      return { kind: "fresh", value, status };
    } catch (error) {
      const refusal = asRefusal(error);
      if (refusal) {
        const stored: StoredError = { error: { code: refusal.code, message: refusal.message, fieldErrors: refusal.fieldErrors } };
        await this.db
          .update(idempotencyKeys)
          .set({ status: "completed", responseStatus: refusal.getStatus(), responseBody: stored, completedAt: new Date() })
          .where(and(eq(idempotencyKeys.tenantId, context.tenantId), eq(idempotencyKeys.key, key)));
      } else {
        await this.db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.tenantId, context.tenantId), eq(idempotencyKeys.key, key)));
      }
      throw error;
    }
  }

  /** Removes completed keys older than the given number of days. Devices retry for far less than this. */
  async prune(olderThanDays = 30) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    await this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff));
  }

  private async claim(context: { tenantId: string; membershipId: string }, key: string, scope: string, hash: string) {
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ tenantId: context.tenantId, key, scope, requestHash: hash, membershipId: context.membershipId })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return true;
    // Take over a stale claim from the same sender for the same request.
    const takenOver = await this.db
      .update(idempotencyKeys)
      .set({ createdAt: new Date() })
      .where(
        and(
          eq(idempotencyKeys.tenantId, context.tenantId),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, "in_progress"),
          eq(idempotencyKeys.membershipId, context.membershipId),
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.requestHash, hash),
          lt(idempotencyKeys.createdAt, sql`now() - ${`${STALE_AFTER_MS} milliseconds`}::interval`),
        ),
      )
      .returning({ key: idempotencyKeys.key });
    return takenOver.length > 0;
  }

  private async replay<T>(
    context: { tenantId: string; membershipId: string },
    key: string,
    scope: string,
    hash: string,
  ): Promise<IdempotentOutcome<T>> {
    const [existing] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, context.tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!existing) {
      throw new ApiError("IDEMPOTENCY_RETRY", "Please try again.", 409);
    }
    if (existing.membershipId !== context.membershipId || existing.scope !== scope || existing.requestHash !== hash) {
      throw new ApiError(
        "IDEMPOTENCY_KEY_REUSED",
        "This request key was already used for a different request. Create a new key for each new action.",
        422,
      );
    }
    if (existing.status !== "completed" || existing.responseStatus === null) {
      throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "This request is still being processed. Try again shortly.", 409);
    }
    const body = existing.responseBody as StoredError | unknown;
    if (existing.responseStatus >= 400) {
      const stored = (body as StoredError).error;
      throw new ApiError(stored.code, stored.message, existing.responseStatus, stored.fieldErrors);
    }
    return { kind: "replayed", body, status: existing.responseStatus };
  }
}
