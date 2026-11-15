import { Inject, Injectable } from "@nestjs/common";
import { type SyncOperationResult, syncPushSchema } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { asRefusal, IdempotencyService, requestHash } from "../idempotency/idempotency.service.js";
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
            return { value: await handler.handle(tenant, operation), status: 200 };
          },
        );
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
}
