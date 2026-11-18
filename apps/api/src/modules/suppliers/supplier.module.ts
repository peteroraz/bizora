import { Module } from "@nestjs/common";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { SupplierController } from "./supplier.controller.js";
import { SupplierService } from "./supplier.service.js";

/** Suppliers and what is owed to them (ADR-029). */
@Module({
  imports: [TenantModule, IdempotencyModule, LedgerModule],
  controllers: [SupplierController],
  providers: [SupplierService, PermissionGuard],
  exports: [SupplierService],
})
export class SupplierModule {}
