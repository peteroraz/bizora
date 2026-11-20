import { Module } from "@nestjs/common";
import { DebtorsModule } from "../debtors/debtors.module.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { InventoryModule } from "../inventory/inventory.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SalesModule } from "../sales/sales.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { JobController } from "./job.controller.js";
import { JobService } from "./job.service.js";

/** Jobs for customers (ADR-035). */
@Module({
  imports: [TenantModule, IdempotencyModule, DocumentsModule, LedgerModule, InventoryModule, SalesModule, DebtorsModule],
  controllers: [JobController],
  providers: [JobService, PermissionGuard],
  exports: [JobService],
})
export class JobsModule {}
