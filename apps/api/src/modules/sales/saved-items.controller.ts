import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { Permission, SAVED_ITEMS_LIMIT, success, type SavedItem } from "@bizora/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { savedItems } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness } from "../inventory/inventory-scope.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";

/**
 * Items typed in at sales and remembered (ADR-041). Staff who sell get the list, with the shop's setting, so the
 * phone can offer them with no network. Whoever manages the business settings or products can remove one.
 */
@Controller("api/v1/saved-items")
@UseGuards(TenantGuard, PermissionGuard)
export class SavedItemsController {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.BUSINESS_SETTINGS_MANAGE, Permission.PRODUCTS_MANAGE)
  async list(@CurrentTenant() tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select()
      .from(savedItems)
      .where(and(eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt)))
      .orderBy(desc(savedItems.timesSold), desc(sql`coalesce(${savedItems.lastSoldAt}, ${savedItems.createdAt})`))
      .limit(SAVED_ITEMS_LIMIT + 1);
    const items: SavedItem[] = rows.slice(0, SAVED_ITEMS_LIMIT).map((row) => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      lastPriceMinor: row.lastPriceMinor?.toString() ?? null,
      timesSold: row.timesSold,
      lastSoldAt: row.lastSoldAt?.toISOString() ?? null,
    }));
    return success({ salesItems: business.salesItems, items, truncated: rows.length > SAVED_ITEMS_LIMIT }, tenant.correlationId);
  }

  @Delete(":id")
  @HttpCode(200)
  @RequireAnyPermission(Permission.BUSINESS_SETTINGS_MANAGE, Permission.PRODUCTS_MANAGE)
  async remove(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string) {
    const business = await requireBusiness(this.db, tenant);
    const [removed] = await this.db
      .update(savedItems)
      .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: tenant.userId })
      .where(and(eq(savedItems.id, id), eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt)))
      .returning();
    if (!removed) throw new ApiError("NOT_FOUND", "That saved item was not found.", 404);
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "saved_item.removed",
      entityType: "saved_item",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { name: removed.name },
    });
    return success({ removed: true }, tenant.correlationId);
  }
}
