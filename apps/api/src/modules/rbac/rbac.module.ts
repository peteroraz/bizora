import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module.js";
import { InvitationService } from "./invitation.service.js";
import { PermissionGuard } from "./permission.guard.js";
import { RbacController } from "./rbac.controller.js";

@Module({
  imports: [TenantModule],
  controllers: [RbacController],
  providers: [InvitationService, PermissionGuard],
  exports: [InvitationService, PermissionGuard],
})
export class RbacModule {}
