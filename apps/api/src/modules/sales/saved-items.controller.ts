import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { QuickCatalogService } from "./quick-catalog.service.js";

/**
 * Items the business has sold or imported by name (ADR-041, ADR-049). Staff who sell can use them.
 * Organising the list (rename, import, merge, stock) needs a higher job.
 */
@Controller("api/v1/saved-items")
@UseGuards(TenantGuard, PermissionGuard)
export class SavedItemsController {
  constructor(@Inject(QuickCatalogService) private readonly catalog: QuickCatalogService) {}

  @Get()
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.BUSINESS_SETTINGS_MANAGE, Permission.PRODUCTS_MANAGE, Permission.CATALOG_MANAGE)
  list(@CurrentTenant() tenant: TenantContext) {
    return this.catalog.list(tenant).then((data) => success(data, tenant.correlationId));
  }

  @Get("suggest")
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.CATALOG_MANAGE)
  suggest(@CurrentTenant() tenant: TenantContext, @Query("q") q = "") {
    return this.catalog.suggest(tenant, q).then((data) => success(data, tenant.correlationId));
  }

  @Post("import")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  importNames(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return this.catalog.importNames(tenant, body).then((data) => success(data, tenant.correlationId));
  }

  @Post("merge")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_MERGE)
  merge(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return this.catalog.merge(tenant, body).then((data) => success(data, tenant.correlationId));
  }

  @Patch(":id")
  @RequirePermissions(Permission.CATALOG_MANAGE)
  rename(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.catalog.rename(tenant, id, body).then((data) => success(data, tenant.correlationId));
  }

  @Post(":id/aliases")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  addAlias(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.catalog.addAlias(tenant, id, body).then((data) => success(data, tenant.correlationId));
  }

  @Delete(":id/aliases/:aliasId")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  removeAlias(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Param("aliasId", new ParseUUIDPipe()) aliasId: string) {
    return this.catalog.removeAlias(tenant, id, aliasId).then((data) => success(data, tenant.correlationId));
  }

  @Post(":id/upgrade")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_CONVERT_TO_MANAGED)
  upgrade(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.catalog.upgrade(tenant, id, body).then((data) => success(data, tenant.correlationId));
  }

  @Post(":id/cost-estimate")
  @HttpCode(200)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  estimate(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.catalog.estimateCost(tenant, id, body).then((data) => success(data, tenant.correlationId));
  }

  @Delete(":id")
  @HttpCode(200)
  @RequireAnyPermission(Permission.BUSINESS_SETTINGS_MANAGE, Permission.PRODUCTS_MANAGE, Permission.CATALOG_MANAGE)
  remove(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.catalog.remove(tenant, id).then((data) => success(data, tenant.correlationId));
  }
}
