import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { CountSessionService } from "./count-session.service.js";
import { TransferService } from "./transfer.service.js";

/**
 * Transfers with a lifecycle and count sessions (ADR-047).
 * - Transfers: asking and sending need `stock.transfer`; approving needs `stock.adjust`; receiving needs
 *   `stock.transfer` or `stock.receive`, at the receiving place.
 * - Counts: counting needs `stock.count`; approving and posting need `stock.adjust`.
 */
@Controller("api/v1/inventory")
@UseGuards(TenantGuard, PermissionGuard)
export class StockOperationsController {
  constructor(
    @Inject(TransferService) private readonly transfers: TransferService,
    @Inject(CountSessionService) private readonly counts: CountSessionService,
  ) {}

  @Get("transfers")
  @RequirePermissions(Permission.STOCK_READ)
  async listTransfers(@CurrentTenant() tenant: TenantContext, @Query("status") status?: string) {
    return success({ transfers: await this.transfers.list(tenant, { ...(status ? { status } : {}) }) }, tenant.correlationId);
  }

  @Get("transfers/:id")
  @RequirePermissions(Permission.STOCK_READ)
  async transfer(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ transfer: await this.transfers.get(tenant, id) }, tenant.correlationId);
  }

  @Post("transfers")
  @RequirePermissions(Permission.STOCK_TRANSFER)
  @Idempotent()
  async createTransfer(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ transfer: await this.transfers.create(tenant, body) }, tenant.correlationId);
  }

  @Post("transfers/:id/approve")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async approveTransfer(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ transfer: await this.transfers.approve(tenant, id, body) }, tenant.correlationId);
  }

  @Post("transfers/:id/dispatch")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_TRANSFER)
  @Idempotent()
  async dispatchTransfer(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ transfer: await this.transfers.dispatch(tenant, id) }, tenant.correlationId);
  }

  @Post("transfers/:id/receive")
  @HttpCode(200)
  @RequireAnyPermission(Permission.STOCK_TRANSFER, Permission.STOCK_RECEIVE)
  @Idempotent()
  async receiveTransfer(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ transfer: await this.transfers.receive(tenant, id, body) }, tenant.correlationId);
  }

  @Post("transfers/:id/cancel")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_TRANSFER)
  @Idempotent()
  async cancelTransfer(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ transfer: await this.transfers.cancel(tenant, id, body) }, tenant.correlationId);
  }

  @Get("counts")
  @RequirePermissions(Permission.STOCK_READ)
  async listCounts(@CurrentTenant() tenant: TenantContext) {
    return success({ counts: await this.counts.list(tenant) }, tenant.correlationId);
  }

  @Get("counts/:id")
  @RequirePermissions(Permission.STOCK_READ)
  async countSession(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ count: await this.counts.get(tenant, id) }, tenant.correlationId);
  }

  @Post("counts")
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async createCount(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ count: await this.counts.create(tenant, body) }, tenant.correlationId);
  }

  @Post("counts/:id/lines")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async countLine(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.counts.count(tenant, id, body) }, tenant.correlationId);
  }

  @Delete("counts/:id/lines/:productId")
  @RequirePermissions(Permission.STOCK_COUNT)
  async removeCountLine(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("productId", ParseUUIDPipe) productId: string) {
    return success({ count: await this.counts.removeLine(tenant, id, productId) }, tenant.correlationId);
  }

  @Post("counts/:id/submit")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async submitCount(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ count: await this.counts.submit(tenant, id) }, tenant.correlationId);
  }

  @Post("counts/:id/approve")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async approveCount(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.counts.approve(tenant, id, body) }, tenant.correlationId);
  }

  @Post("counts/:id/reject")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_ADJUST)
  @Idempotent()
  async rejectCount(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ count: await this.counts.reject(tenant, id, body) }, tenant.correlationId);
  }

  @Post("counts/:id/cancel")
  @HttpCode(200)
  @RequirePermissions(Permission.STOCK_COUNT)
  @Idempotent()
  async cancelCount(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ count: await this.counts.cancel(tenant, id) }, tenant.correlationId);
  }
}
