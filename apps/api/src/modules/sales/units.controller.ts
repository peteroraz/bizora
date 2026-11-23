import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { QuickCatalogService } from "./quick-catalog.service.js";

/** Units a business sells in, beside the standard list (ADR-049). cup, mudu, bowl and the rest. */
@Controller("api/v1/units")
@UseGuards(TenantGuard, PermissionGuard)
export class UnitsController {
  constructor(@Inject(QuickCatalogService) private readonly catalog: QuickCatalogService) {}

  @Get()
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.CATALOG_MANAGE, Permission.PRODUCTS_MANAGE)
  list(@CurrentTenant() tenant: TenantContext) {
    return this.catalog.units(tenant).then((data) => success(data, tenant.correlationId));
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  add(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return this.catalog.addUnit(tenant, body).then((data) => success(data, tenant.correlationId));
  }

  @Patch(":id")
  @RequirePermissions(Permission.CATALOG_MANAGE)
  patch(@CurrentTenant() tenant: TenantContext, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.catalog.patchUnit(tenant, id, body).then((data) => success(data, tenant.correlationId));
  }
}
