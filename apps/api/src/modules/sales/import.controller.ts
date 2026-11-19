import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { ImportService } from "./import.service.js";

@Controller("api/v1/imports")
@UseGuards(TenantGuard, PermissionGuard)
export class ImportController {
  constructor(@Inject(ImportService) private readonly imports: ImportService) {}

  /** Products and current stock from a CSV. dryRun: true checks every row; false saves when no row has a problem. */
  @Post("products")
  @HttpCode(200)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @Idempotent()
  async products(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.products(tenant, body), tenant.correlationId);
  }

  /** Sales from a CSV, counted fully or kept as history (mode). */
  @Post("sales")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_CREATE)
  @Idempotent()
  async sales(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.salesImport(tenant, body), tenant.correlationId);
  }

  /** A supplier delivery (stock in): every product must already exist. Paying the supplier needs purchases.manage. */
  @Post("stock-in")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_RECEIVE)
  @Idempotent()
  async stockIn(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.stockIn(tenant, body), tenant.correlationId);
  }

  /** Spoken, photographed or file lists of counts, changes and moves (ADR-033). */
  @Post("stock-count")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async stockCount(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.stockCount(tenant, body), tenant.correlationId);
  }

  @Post("stock-change")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async stockChange(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.stockChange(tenant, body), tenant.correlationId);
  }

  @Post("stock-move")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_TRANSFER)
  @Idempotent()
  async stockMove(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.imports.stockMove(tenant, body), tenant.correlationId);
  }
}
