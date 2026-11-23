import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { SupplierService } from "./supplier.service.js";

/**
 * Suppliers (ADR-029). Names, for stock in: stock.receive. What is owed: purchases.manage or money.read. Adding,
 * changing and paying suppliers: purchases.manage. Cancelling a payment or an amount from before: expenses.approve.
 */
@Controller("api/v1/suppliers")
@UseGuards(TenantGuard, PermissionGuard)
export class SupplierController {
  constructor(@Inject(SupplierService) private readonly suppliers: SupplierService) {}

  @Get("names")
  @RequireAnyPermission(Permission.STOCK_RECEIVE, Permission.PURCHASES_MANAGE)
  async names(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string) {
    return success(await this.suppliers.names(tenant, q), tenant.correlationId);
  }

  @Get("owed")
  @RequireAnyPermission(Permission.PURCHASES_MANAGE, Permission.MONEY_READ)
  async owed(@CurrentTenant() tenant: TenantContext) {
    return success(await this.suppliers.owedTotals(tenant), tenant.correlationId);
  }

  @Get()
  @RequireAnyPermission(Permission.PURCHASES_MANAGE, Permission.MONEY_READ)
  async list(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string, @Query("archived") archived?: string) {
    return success(await this.suppliers.list(tenant, { ...(q ? { q } : {}), archived: archived === "true" }), tenant.correlationId);
  }

  @Post()
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  @Idempotent()
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.suppliers.create(tenant, body), tenant.correlationId);
  }

  @Get(":id")
  @RequireAnyPermission(Permission.PURCHASES_MANAGE, Permission.MONEY_READ)
  async detail(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.suppliers.detail(tenant, id), tenant.correlationId);
  }

  @Patch(":id")
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  async update(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.suppliers.update(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/payments")
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  @Idempotent()
  async pay(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.suppliers.pay(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/opening")
  @RequirePermissions(Permission.PURCHASES_MANAGE)
  @Idempotent()
  async opening(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.suppliers.addOpening(tenant, id, body), tenant.correlationId);
  }

  @Post("entries/:entryId/void")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.EXPENSES_APPROVE)
  async voidEntry(@CurrentTenant() tenant: TenantContext, @Param("entryId", ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    return success(await this.suppliers.voidEntry(tenant, entryId, body), tenant.correlationId);
  }
}
