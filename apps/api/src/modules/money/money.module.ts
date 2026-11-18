import { Module } from "@nestjs/common";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { MoneyController } from "./money.controller.js";
import { MoneyService } from "./money.service.js";

/** Money in and out, cash per shop and profit (ADR-028). */
@Module({
  imports: [TenantModule, IdempotencyModule, LedgerModule],
  controllers: [MoneyController],
  providers: [MoneyService, PermissionGuard],
  exports: [MoneyService],
})
export class MoneyModule {}
