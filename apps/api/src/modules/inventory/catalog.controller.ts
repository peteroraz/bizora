import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { CatalogService } from "./catalog.service.js";

/**
 * The catalog (ADR-046). Reading needs `stock.read` (catalog.view); creating, editing and archiving need
 * `products.manage` (catalog.create, catalog.edit, catalog.archive). Cost shows only with `prices.cost.read`.
 */
@Controller("api/v1/catalog")
@UseGuards(TenantGuard, PermissionGuard)
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get("categories")
  @RequirePermissions(Permission.STOCK_READ)
  async categories(@CurrentTenant() tenant: TenantContext) {
    return success({ categories: await this.catalog.categories(tenant) }, tenant.correlationId);
  }

  @Post("categories")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async createCategory(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ category: await this.catalog.createCategory(tenant, body) }, tenant.correlationId);
  }

  @Patch("categories/:id")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async updateCategory(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ category: await this.catalog.updateCategory(tenant, id, body) }, tenant.correlationId);
  }

  @Get("brands")
  @RequirePermissions(Permission.STOCK_READ)
  async brands(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string) {
    return success({ brands: await this.catalog.brands(tenant, q) }, tenant.correlationId);
  }

  @Post("brands")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async createBrand(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ brand: await this.catalog.createBrand(tenant, body) }, tenant.correlationId);
  }

  @Patch("brands/:id")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async updateBrand(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ brand: await this.catalog.updateBrand(tenant, id, body) }, tenant.correlationId);
  }

  @Get("items")
  @RequirePermissions(Permission.STOCK_READ)
  async items(
    @CurrentTenant() tenant: TenantContext,
    @Query("q") q?: string,
    @Query("categoryId") categoryId?: string,
    @Query("brandId") brandId?: string,
    @Query("type") type?: string,
    @Query("page") page?: string,
  ) {
    const uuid = (value?: string) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
    const result = await this.catalog.items(tenant, {
      ...(q ? { q } : {}),
      ...(uuid(categoryId) ? { categoryId: uuid(categoryId) as string } : {}),
      ...(uuid(brandId) ? { brandId: uuid(brandId) as string } : {}),
      ...(type ? { type } : {}),
      page: Number.parseInt(page ?? "1", 10) || 1,
    });
    return success(result, tenant.correlationId);
  }

  @Get("items/:id")
  @RequirePermissions(Permission.STOCK_READ)
  async item(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ item: await this.catalog.item(tenant, id) }, tenant.correlationId);
  }

  @Post("items")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async createItem(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ item: await this.catalog.createItem(tenant, body) }, tenant.correlationId);
  }

  @Patch("items/:id")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async updateItem(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ item: await this.catalog.updateItem(tenant, id, body) }, tenant.correlationId);
  }

  @Post("items/:id/variants")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async addVariant(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ item: await this.catalog.addVariant(tenant, id, body) }, tenant.correlationId);
  }

  @Post("items/:id/archive")
  @HttpCode(200)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async archiveItem(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.catalog.archiveItem(tenant, id, body), tenant.correlationId);
  }
}
