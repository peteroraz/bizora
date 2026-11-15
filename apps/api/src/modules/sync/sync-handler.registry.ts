import { Injectable } from "@nestjs/common";
import type { PermissionCode, SyncOperation, SyncOperationType } from "@bizora/contracts";
import type { TenantContext } from "../../common/tenant-context.js";

/** One kind of work a device can queue offline. Modules register their handlers; Sprint 4 adds stock, Sprint 5 sales. */
export type SyncHandler = {
  type: SyncOperationType;
  /** The person must hold at least one of these, checked for every operation. */
  anyOf: PermissionCode[];
  handle(tenant: TenantContext, operation: SyncOperation): Promise<unknown>;
};

@Injectable()
export class SyncHandlerRegistry {
  private readonly handlers = new Map<SyncOperationType, SyncHandler>();

  register(handler: SyncHandler) {
    if (this.handlers.has(handler.type)) throw new Error(`Sync handler ${handler.type} is already registered`);
    this.handlers.set(handler.type, handler);
  }

  get(type: SyncOperationType) {
    return this.handlers.get(type);
  }
}
