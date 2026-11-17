import { Module } from "@nestjs/common";
import { DebtorsModule } from "../debtors/debtors.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ReconciliationController } from "./reconciliation.controller.js";
import { ReconciliationService } from "./reconciliation.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, LedgerModule, DebtorsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, PermissionGuard],
})
export class ReconciliationModule {}
