import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { PricingService } from "./pricing.service.js";
import { StockReceiptService } from "./stock-receipt.service.js";

/**
 * Price lists, suppliers per product and deliveries with charges (ADR-048). Seeing lists: anyone who sells or reads
 * stock (staff see only the lists they may use). Changing lists and giving customers one: pricing.lists.manage.
 * Suppliers of a product: stock.read to see (costs need prices.cost.read), purchases.manage to change. A delivery
 * with charges pays money out, so it needs purchases.manage.
 */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class PricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(StockReceiptService) private readonly receipts: StockReceiptService,
  ) {}

  @Get("pricing/lists")
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.STOCK_READ, Permission.PRICING_LISTS_MANAGE)
  async lists(@CurrentTenant() tenant: TenantContext) {
    return success(await this.pricing.lists(tenant), tenant.correlationId);
  }

  @Get("pricing/for-sale")
  @RequirePermissions(Permission.SALES_CREATE)
  async forSale(@CurrentTenant() tenant: TenantContext, @Query("customerId") customerId?: string, @Query("priceListId") priceListId?: string, @Query("branchId") branchId?: string) {
    return success(
      await this.pricing.forSale(tenant, { ...(customerId ? { customerId } : {}), ...(priceListId ? { priceListId } : {}), ...(branchId ? { branchId } : {}) }),
      tenant.correlationId,
    );
  }

  @Post("pricing/lists")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  @Idempotent()
  async createList(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.pricing.createList(tenant, body), tenant.correlationId);
  }

  @Patch("pricing/lists/:id")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  async updateList(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.pricing.updateList(tenant, id, body), tenant.correlationId);
  }

  @Get("pricing/lists/:id/prices")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  async prices(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Query("productId") productId?: string) {
    return success(await this.pricing.prices(tenant, id, productId ? { productId } : {}), tenant.correlationId);
  }

  @Put("pricing/lists/:id/prices")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  async setPrices(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.pricing.setPrices(tenant, id, body), tenant.correlationId);
  }

  @Delete("pricing/lists/:id/prices/:priceId")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  @HttpCode(200)
  async removePrice(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("priceId", ParseUUIDPipe) priceId: string) {
    return success(await this.pricing.removePrice(tenant, id, priceId), tenant.correlationId);
  }

  @Get("pricing/products/:id")
  @RequireAnyPermission(Permission.PRICING_LISTS_MANAGE, Permission.SALES_DISCOUNT)
  async productPrices(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.pricing.productPrices(tenant, id), tenant.correlationId);
  }

  @Put("customers/:id/price-list")
  @RequirePermissions(Permission.PRICING_LISTS_MANAGE)
  async setCustomerList(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.pricing.setCustomerList(tenant, id, body), tenant.correlationId);
  }

  @Get("products/:id/suppliers")
  @RequirePermissions(Permission.STOCK_READ)
  async productSuppliers(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.pricing.productSuppliers(tenant, id), tenant.correlationId);
  }

  @Put("suppliers/:id/products")
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  async setSupplierProduct(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.pricing.setSupplierProduct(tenant, id, body), tenant.correlationId);
  }

  @Delete("suppliers/:id/products/:productId")
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  @HttpCode(200)
  async removeSupplierProduct(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("productId", ParseUUIDPipe) productId: string) {
    return success(await this.pricing.removeSupplierProduct(tenant, id, productId), tenant.correlationId);
  }

  @Post("stock/receipts")
  @RequirePermissions(Permission.STOCK_RECEIVE, Permission.PURCHASES_MANAGE)
  @Idempotent()
  async createReceipt(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.receipts.create(tenant, body), tenant.correlationId);
  }

  @Get("stock/receipts/:id")
  @RequirePermissions(Permission.STOCK_RECEIVE)
  async receipt(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.receipts.get(tenant, id), tenant.correlationId);
  }
}
