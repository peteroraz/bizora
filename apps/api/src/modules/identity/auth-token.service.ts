import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sha256Hex } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { authTokens } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";

type TokenStore = Pick<AppDatabase, "update">;

export type AuthTokenPurpose = "verify_email" | "password_reset";

@Injectable()
export class AuthTokenService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async issue(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
    const raw = randomBytes(32).toString("base64url");
    const token = `${raw}.${this.sign(purpose, raw)}`;
    await this.db.insert(authTokens).values({
      id: newId(),
      userId,
      purpose,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
  }

  async consume(token: string, purpose: AuthTokenPurpose, store: TokenStore = this.db): Promise<string | null> {
    if (!this.validSignature(token, purpose)) return null;
    const [row] = await store
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, sha256Hex(token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    return row?.userId ?? null;
  }

  private sign(purpose: AuthTokenPurpose, raw: string): string {
    return createHmac("sha256", this.env.JWT_SECRET).update(`${purpose}.${raw}`).digest("base64url");
  }

  private validSignature(token: string, purpose: AuthTokenPurpose): boolean {
    const split = token.lastIndexOf(".");
    if (split <= 0) return false;
    const raw = token.slice(0, split);
    const signature = token.slice(split + 1);
    const expected = this.sign(purpose, raw);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }
}
