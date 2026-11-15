import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { InvitationService } from "./invitation.service.js";
import { PermissionGuard } from "./permission.guard.js";
import { RbacController } from "./rbac.controller.js";

@Module({
  imports: [TenantModule, EntitlementsModule],
  controllers: [RbacController],
  providers: [InvitationService, PermissionGuard],
  exports: [InvitationService, PermissionGuard],
})
export class RbacModule {}
