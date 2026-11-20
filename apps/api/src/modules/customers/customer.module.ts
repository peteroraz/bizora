import { Module } from "@nestjs/common";
import { AddressModule } from "../addresses/address.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { SyncModule } from "../sync/sync.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { CustomersController } from "./customer.controller.js";
import { CustomerSyncHandler } from "./customer-sync.handler.js";
import { CustomerService } from "./customer.service.js";

@Module({
  imports: [TenantModule, AddressModule, IdempotencyModule, SyncModule],
  controllers: [CustomersController],
  providers: [CustomerService, CustomerSyncHandler, PermissionGuard],
  exports: [CustomerService],
})
export class CustomersModule {}
