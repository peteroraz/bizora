import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ShopDeviceService } from "./shop-device.service.js";
import { ShopController, StaffController } from "./staff.controller.js";
import { StaffService } from "./staff.service.js";

@Module({
  imports: [TenantModule, EntitlementsModule],
  controllers: [StaffController, ShopController],
  providers: [StaffService, ShopDeviceService, PermissionGuard],
})
export class StaffModule {}
