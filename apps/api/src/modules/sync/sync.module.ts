import { Module } from "@nestjs/common";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { WorkRulesModule } from "../work-rules/work-rules.module.js";
import { SyncController } from "./sync.controller.js";
import { SyncHandlerRegistry } from "./sync-handler.registry.js";
import { SyncService } from "./sync.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, WorkRulesModule],
  controllers: [SyncController],
  providers: [SyncService, SyncHandlerRegistry],
  exports: [SyncHandlerRegistry],
})
export class SyncModule {}
