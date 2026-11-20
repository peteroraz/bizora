import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { adminAudit } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";

/** What Bizora staff looked at or did in this business (ADR-039), for the owner to see. */
@Controller("api/v1/support-activity")
@UseGuards(TenantGuard, PermissionGuard)
export class SupportActivityController {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  async list(@CurrentTenant() tenant: TenantContext) {
    const rows = await this.db
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.tenantId, tenant.tenantId), notInArray(adminAudit.action, ["support.view_closed"])))
      .orderBy(desc(adminAudit.createdAt))
      .limit(200);
    return success(
      {
        items: rows.map((row) => ({
          id: row.id,
          at: row.createdAt.toISOString(),
          staffEmail: row.staffEmail,
          action: row.action,
          reason: row.reason,
          page: typeof row.metadata?.page === "string" ? row.metadata.page : null,
        })),
      },
      tenant.correlationId,
    );
  }
}
