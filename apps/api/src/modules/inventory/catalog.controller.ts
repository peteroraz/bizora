import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { AttributeService } from "./attribute.service.js";
import { CatalogService } from "./catalog.service.js";

/**
 * The catalog (ADR-046). Reading needs `stock.read` (catalog.view); creating, editing and archiving need
 * `products.manage` (catalog.create, catalog.edit, catalog.archive). Cost shows only with `prices.cost.read`.
 */
@Controller("api/v1/catalog")
@UseGuards(TenantGuard, PermissionGuard)
export class CatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AttributeService) private readonly attributes: AttributeService,
  ) {}

  // Attributes (ADR-060) ------------------------------------------------------------------------------------------

  @Get("attributes")
  @RequirePermissions(Permission.STOCK_READ)
  async attributeList(@CurrentTenant() tenant: TenantContext) {
    return success(await this.attributes.list(tenant), tenant.correlationId);
  }

  @Post("attributes")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async createAttribute(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ attribute: await this.attributes.create(tenant, body) }, tenant.correlationId);
  }

  @Patch("attributes/:id")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async updateAttribute(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ attribute: await this.attributes.update(tenant, id, body) }, tenant.correlationId);
  }

  @Get("products/:id/attributes")
  @RequirePermissions(Permission.STOCK_READ)
  async productAttributes(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.attributes.productValues(tenant, id), tenant.correlationId);
  }

  @Put("products/:id/attributes")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async setProductAttributes(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.attributes.setProductValues(tenant, id, body), tenant.correlationId);
  }

  @Post("items/:id/generate-variants")
  @HttpCode(200)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async generateVariants(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.attributes.generateVariants(tenant, id, body), tenant.correlationId);
  }

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
