import { Inject, Injectable } from "@nestjs/common";
import { type SyncOperationResult, syncPushSchema } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { asRefusal, IdempotencyService, requestHash } from "../idempotency/idempotency.service.js";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../../db/database.js";
import { branches } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { WorkRulesService } from "../work-rules/work-rules.service.js";
import { SyncHandlerRegistry } from "./sync-handler.registry.js";

/**
 * Applies operations from a device outbox, in order, each at most once (the operation ID is its idempotency key).
 * Each operation is checked against the sender's permissions and scope exactly like a normal request.
 * Devices never write ledger rows; any posting happens here, on the server, when an operation is applied.
 */
@Injectable()
export class SyncService {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(WorkRulesService) private readonly rules: WorkRulesService,
    @Inject(DB) private readonly db: AppDatabase,
  ) {}

  async push(tenant: TenantContext, raw: unknown): Promise<{ results: SyncOperationResult[] }> {
    const { operations } = syncPushSchema.parse(raw);
    const results: SyncOperationResult[] = [];
    for (const operation of operations) {
      const handler = this.registry.get(operation.type);
      if (!handler) {
        results.push({ id: operation.id, status: "rejected", error: { code: "UNKNOWN_OPERATION", message: "This kind of change is not supported." } });
        continue;
      }
      const scope = `sync:${operation.type}`;
      try {
        const outcome = await this.idempotency.run(
          { tenantId: tenant.tenantId, membershipId: tenant.membershipId },
          operation.id,
          scope,
          requestHash(scope, operation.payload),
          async () => {
            if (!handler.anyOf.some((code) => tenant.permissions.includes(code))) {
              throw new ApiError("FORBIDDEN", "You do not have permission to perform this action.", 403);
            }
            // Work done offline belongs to the shop it was done in, even if the person has since switched shop.
            const { scoped, payload } = await this.inShopOf(tenant, operation.payload);
            return { value: await handler.handle(scoped, { ...operation, payload }), status: 200 };
          },
        );
        if (outcome.kind === "fresh") await this.flagIfOutsideRules(tenant, operation);
        results.push(
          outcome.kind === "fresh"
            ? { id: operation.id, status: "applied", result: outcome.value }
            : { id: operation.id, status: "duplicate", result: outcome.body },
        );
      } catch (error) {
        const refusal = asRefusal(error);
        if (refusal) {
          results.push({ id: operation.id, status: "rejected", error: { code: refusal.code, message: refusal.message } });
          continue;
        }
        // Anything else (database down, bug): stop here so later operations keep their order. The device retries.
        throw error;
      }
    }
    return { results };
  }

  /**
   * The phone records which shop offline work was done in (`branchId` on the payload). It is checked like a shop
   * chosen at sign-in: it must be this business's, open, and one the person may work in. Without it (older phones),
   * the shop selected now is used, as before.
   */
  private async inShopOf(tenant: TenantContext, raw: unknown): Promise<{ scoped: TenantContext; payload: unknown }> {
    if (!raw || typeof raw !== "object" || typeof (raw as { branchId?: unknown }).branchId !== "string") return { scoped: tenant, payload: raw };
    const { branchId, ...payload } = raw as { branchId: string } & Record<string, unknown>;
    if (branchId === tenant.branchId) return { scoped: tenant, payload };
    if (tenant.membershipBranchId && tenant.membershipBranchId !== branchId) {
      throw new ApiError("SHOP_NOT_ALLOWED", "This was saved in a shop you no longer work in. Ask the owner to record it.", 403);
    }
    const [branch] = await this.db.select().from(branches).where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, branchId))).limit(1);
    if (!branch || (tenant.businessId && branch.businessId !== tenant.businessId)) {
      throw new ApiError("SHOP_NOT_FOUND", "The shop this was saved in is no longer available. Record it again in the right shop.", 404);
    }
    if (branch.closedAt) {
      throw new ApiError("SHOP_CLOSED", `${branch.name} was closed after this was saved. Record it again in the shop that took over.`, 409);
    }
    return { scoped: { ...tenant, branchId, businessId: branch.businessId }, payload };
  }

  /**
   * Work done offline in a locked shop or outside opening hours already happened, so it is kept; the owner is told
   * and the activity log shows it (ADR-034).
   */
  private async flagIfOutsideRules(tenant: TenantContext, operation: { type: string; occurredAt: string; payload?: unknown }) {
    const said = new Date(operation.occurredAt);
    const at = said.getTime() > Date.now() ? new Date() : said;
    const payload = (operation.payload ?? {}) as Record<string, unknown>;
    const shopId = typeof payload.branchId === "string" ? payload.branchId : tenant.branchId;
    const refusal = await this.rules.refusal(tenant, [shopId, tenant.membershipBranchId], at);
    if (refusal) await this.db.transaction((tx) => this.rules.flagOffline(tx, tenant, refusal, { type: operation.type, at, shopId: shopId ?? null }));
  }
}
