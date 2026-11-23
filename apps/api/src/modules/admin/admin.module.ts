import { Module } from "@nestjs/common";
import { CustomersModule } from "../customers/customer.module.js";
import { DebtorsModule } from "../debtors/debtors.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InventoryModule } from "../inventory/inventory.module.js";
import { MoneyModule } from "../money/money.module.js";
import { SalesModule } from "../sales/sales.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { AdminBusinessController } from "./admin-business.controller.js";
import { AdminLimitsService } from "./admin-limits.service.js";
import { AdminRecordsService } from "./admin-records.service.js";
import { SupportActivityController } from "./support-activity.controller.js";
import { RbacModule } from "../rbac/rbac.module.js";
import { StaffModule } from "../staff/staff.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { AdminMeasuresService } from "./admin-measures.service.js";
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
  imports: [IdentityModule, RbacModule, StaffModule, TenantModule, EntitlementsModule, SalesModule, InventoryModule, CustomersModule, DebtorsModule, MoneyModule],
  controllers: [AdminAuthController, AdminController, AdminStaffController, AdminBusinessController, SupportActivityController],
  providers: [AdminMeasuresService, AdminAuditService, AdminSessionService, AdminDirectoryService, AdminStaffService, AdminRecordsService, AdminLimitsService, AdminGuard, PermissionGuard],
})
export class AdminModule {}
