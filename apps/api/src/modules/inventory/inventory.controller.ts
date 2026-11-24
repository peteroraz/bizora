import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { BatchService } from "./batch.service.js";
import { ProductPhotoService } from "./product-photo.service.js";
import { ProductService } from "./product.service.js";
import { SerialService } from "./serial.service.js";
import { StockRequestService } from "./stock-request.service.js";
import { StockService } from "./stock.service.js";

@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class InventoryController {
  constructor(
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(ProductPhotoService) private readonly photos: ProductPhotoService,
    @Inject(StockRequestService) private readonly requests: StockRequestService,
    @Inject(BatchService) private readonly batches: BatchService,
    @Inject(SerialService) private readonly serials: SerialService,
  ) {}

  /** A product's batches in a shop, earliest expiry first (ADR-061). */
  @Get("products/:id/batches")
  @RequirePermissions(Permission.STOCK_READ)
  async productBatches(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Query("branchId") branchId?: string) {
    return success(await this.batches.forProduct(tenant, id, branchId), tenant.correlationId);
  }

  /** Stock past its expiry date, or close to it (ADR-061). */
  @Get("stock/expiring")
  @RequirePermissions(Permission.STOCK_READ)
  async expiring(@CurrentTenant() tenant: TenantContext, @Query("branchId") branchId?: string, @Query("days") days?: string) {
    return success(await this.batches.expiring(tenant, branchId, days), tenant.correlationId);
  }

  /** A product's units in a shop that can be sold, by serial number (ADR-062). */
  @Get("products/:id/serials")
  @RequirePermissions(Permission.STOCK_READ)
  async productSerials(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Query("branchId") branchId?: string) {
    return success(await this.serials.forProduct(tenant, id, branchId), tenant.correlationId);
  }

  /** Finds a unit by its serial number or IMEI, with what happened to it (ADR-062). */
  @Get("stock/serials")
  @RequirePermissions(Permission.STOCK_READ)
  async findSerial(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string) {
    return success(await this.serials.lookup(tenant, q), tenant.correlationId);
  }

  /** Stock changes waiting for a manager or owner (ADR-034). */
  @Get("stock/requests")
  @RequireAnyPermission(Permission.STOCK_ADJUST, Permission.STOCK_RECEIVE, Permission.STOCK_COUNT, Permission.STOCK_TRANSFER)
  async listRequests(@CurrentTenant() tenant: TenantContext) {
    return success(await this.requests.list(tenant), tenant.correlationId);
  }

  @Post("stock/requests/:id/approve")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async approveRequest(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ request: await this.requests.approve(tenant, id, body) }, tenant.correlationId);
  }

  @Post("stock/requests/:id/reject")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  async rejectRequest(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ request: await this.requests.reject(tenant, id, body) }, tenant.correlationId);
  }

  /** Product photos (ADR-033): up to 5 a product. */
  @Get("products/:id/photos")
  @RequirePermissions(Permission.STOCK_READ)
  async listPhotos(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.photos.list(tenant, id), tenant.correlationId);
  }

  @Post("products/:id/photos")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async addPhoto(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.photos.add(tenant, id, body), tenant.correlationId);
  }

  @Post("products/:id/photos/:photoId/main")
  @HttpCode(200)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async mainPhoto(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("photoId", ParseUUIDPipe) photoId: string) {
    return success(await this.photos.makeMain(tenant, id, photoId), tenant.correlationId);
  }

  @Delete("products/:id/photos/:photoId")
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  async removePhoto(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("photoId", ParseUUIDPipe) photoId: string) {
    return success(await this.photos.remove(tenant, id, photoId), tenant.correlationId);
  }

  /** The photo itself, for signed-in staff only; the ?v= in its address changes when the photo does. */
  @Get("products/:id/photos/:photoId")
  @RequirePermissions(Permission.STOCK_READ)
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Cache-Control", "private, max-age=86400")
  async photo(
    @CurrentTenant() tenant: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("photoId", ParseUUIDPipe) photoId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.photos.file(tenant, id, photoId);
    response.setHeader("ETag", file.etag);
    return new StreamableFile(file.data, { type: file.contentType, disposition: "inline", length: file.data.length });
  }

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
  // A store keeper (stock.count) asks; it waits for a manager or owner (ADR-034).
  @RequireAnyPermission(Permission.STOCK_ADJUST, Permission.STOCK_COUNT)
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
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  async approve(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.stock.approveCount(tenant, id, body) }, tenant.correlationId);
  }

  @Post("stock/counts/:id/reject")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  async reject(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.stock.rejectCount(tenant, id, body) }, tenant.correlationId);
  }

  @Get("stock/shops")
  @RequireAnyPermission(Permission.STOCK_TRANSFER, Permission.STOCK_RECEIVE, Permission.PURCHASES_MANAGE)
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
