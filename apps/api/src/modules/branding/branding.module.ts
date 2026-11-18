import { Module } from "@nestjs/common";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { BrandingController, PublicProfileController } from "./branding.controller.js";
import { BrandingService } from "./branding.service.js";

@Module({
  imports: [TenantModule],
  controllers: [BrandingController, PublicProfileController],
  providers: [BrandingService, PermissionGuard],
  exports: [BrandingService],
})
export class BrandingModule {}
