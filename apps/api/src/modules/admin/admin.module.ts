import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { RbacModule } from "../rbac/rbac.module.js";
import { StaffModule } from "../staff/staff.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { AdminAuditService } from "./admin-audit.service.js";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminDirectoryService } from "./admin-directory.service.js";
import { AdminGuard } from "./admin.guard.js";
import { AdminController } from "./admin.controller.js";
import { AdminSessionService } from "./admin-session.service.js";
import { AdminStaffController } from "./admin-staff.controller.js";
import { AdminStaffService } from "./admin-staff.service.js";

/** The Admin portal's API (ADR-037), under /api/admin/v1, with its own sign-in, guard and audit log. */
@Module({
  imports: [IdentityModule, RbacModule, StaffModule, TenantModule],
  controllers: [AdminAuthController, AdminController, AdminStaffController],
  providers: [AdminAuditService, AdminSessionService, AdminDirectoryService, AdminStaffService, AdminGuard],
})
export class AdminModule {}
