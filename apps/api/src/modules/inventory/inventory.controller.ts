import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { ProductService } from "./product.service.js";
import { StockService } from "./stock.service.js";

@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class InventoryController {
  constructor(
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  @Get("products")
  @RequirePermissions(Permission.STOCK_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("category") category?: string,
    @Query("branchId") branchId?: string,
  ) {
    const result = await this.products.list(tenant, {
      ...(q ? { q } : {}),
      page: Number.parseInt(page ?? "1", 10) || 1,
      ...(category ? { category } : {}),
      ...(branchId ? { branchId } : {}),
    });
    return success(result, tenant.correlationId);
  }

  /** Offline download for looking up products and stock with no network. */
  @Get("products/sync")
  @RequirePermissions(Permission.STOCK_READ)
  async pull(@CurrentTenant() tenant: TenantContext, @Query("products") productCursor?: string, @Query("balances") balanceCursor?: string) {
    return success(
      await this.products.pull(tenant, { ...(productCursor ? { products: productCursor } : {}), ...(balanceCursor ? { balances: balanceCursor } : {}) }),
      tenant.correlationId,
    );
  }

  @Get("products/:id")
  @RequirePermissions(Permission.STOCK_READ)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ product: await this.products.get(tenant, id) }, tenant.correlationId);
  }

  @Get("products/:id/movements")
  @RequirePermissions(Permission.STOCK_READ)
  async movements(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Query("branchId") branchId?: string) {
    return success({ items: await this.stock.movements(tenant, id, branchId) }, tenant.correlationId);
  }

  /** Changes to a product and decisions on its counts, with the reasons given (7f). */
  @Get("products/:id/changes")
  @RequirePermissions(Permission.STOCK_READ)
  async changes(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ items: await this.products.changes(tenant, id) }, tenant.correlationId);
  }

  @Post("products")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ product: await this.products.create(tenant, body) }, tenant.correlationId);
  }

  @Patch("products/:id")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async update(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ product: await this.products.update(tenant, id, body) }, tenant.correlationId);
  }

  @Post("products/:id/archive")
  @HttpCode(200)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async archive(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.products.archive(tenant, id, body), tenant.correlationId);
  }

  @Post("stock/receive")
  @RequirePermissions(Permission.STOCK_RECEIVE)
  @Idempotent()
  async receive(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.stock.receive(tenant, body), tenant.correlationId);
  }

  /** Goods sent back to a supplier (ADR-030). Money back from them needs purchases.manage (checked in the service). */
  @Post("stock/return-to-supplier")
  @RequirePermissions(Permission.STOCK_RECEIVE)
  @Idempotent()
  async returnToSupplier(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.stock.returnToSupplier(tenant, body), tenant.correlationId);
  }

  @Post("stock/adjust")
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async adjust(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.stock.adjust(tenant, body), tenant.correlationId);
  }

  @Post("stock/transfer")
  @RequirePermissions(Permission.STOCK_TRANSFER)
  @Idempotent()
  async transfer(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.stock.transfer(tenant, body), tenant.correlationId);
  }

  @Post("stock/counts")
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async count(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ count: await this.stock.count(tenant, body) }, tenant.correlationId);
  }

  @Get("stock/counts")
  @RequirePermissions(Permission.STOCK_ADJUST)
  async pending(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.stock.pendingCounts(tenant) }, tenant.correlationId);
  }

  @Post("stock/counts/:id/approve")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  async approve(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.stock.approveCount(tenant, id, body) }, tenant.correlationId);
  }

  @Post("stock/counts/:id/reject")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  async reject(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.stock.rejectCount(tenant, id, body) }, tenant.correlationId);
  }

  @Get("stock/shops")
  @RequirePermissions(Permission.STOCK_TRANSFER)
  async shops(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.stock.shops(tenant) }, tenant.correlationId);
  }

  @Get("stock/low")
  @RequirePermissions(Permission.STOCK_READ)
  async low(@CurrentTenant() tenant: TenantContext, @Query("branchId") branchId?: string) {
    return success({ items: await this.stock.lowStock(tenant, branchId) }, tenant.correlationId);
  }

  @Get("stock/below-zero")
  @RequirePermissions(Permission.STOCK_ADJUST)
  async belowZero(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.stock.belowZero(tenant) }, tenant.correlationId);
  }
}
