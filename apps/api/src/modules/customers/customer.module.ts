import { Module } from "@nestjs/common";
import { AddressModule } from "../addresses/address.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { CustomersController } from "./customer.controller.js";
import { CustomerService } from "./customer.service.js";

@Module({
  imports: [TenantModule, AddressModule],
  controllers: [CustomersController],
  providers: [CustomerService, PermissionGuard],
})
export class CustomersModule {}
