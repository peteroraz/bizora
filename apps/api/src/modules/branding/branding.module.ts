import { Module } from "@nestjs/common";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { BrandingController } from "./branding.controller.js";
import { BrandingService } from "./branding.service.js";

@Module({
  imports: [TenantModule],
  controllers: [BrandingController],
  providers: [BrandingService, PermissionGuard],
  exports: [BrandingService],
})
export class BrandingModule {}
