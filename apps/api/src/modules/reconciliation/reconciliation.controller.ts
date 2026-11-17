import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { ReconciliationService } from "./reconciliation.service.js";

/** Bank statements and the reconciliation inbox: owners, administrators and accountants (bank.reconcile). */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
@RequirePermissions(Permission.BANK_RECONCILE)
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly reconciliation: ReconciliationService) {}

  @Post("imports/statement")
  @HttpCode(200)
  @Idempotent()
  async importStatement(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.reconciliation.importStatement(tenant, body), tenant.correlationId);
  }

  @Get("reconciliation")
  async inbox(@CurrentTenant() tenant: TenantContext, @Query("status") status?: string, @Query("page") page?: string) {
    return success(await this.reconciliation.inbox(tenant, { ...(status ? { status } : {}), page: Number.parseInt(page ?? "1", 10) || 1 }), tenant.correlationId);
  }

  @Get("reconciliation/counts")
  async counts(@CurrentTenant() tenant: TenantContext) {
    return success(await this.reconciliation.counts(tenant), tenant.correlationId);
  }

  @Get("reconciliation/customers")
  async customers(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string) {
    return success(await this.reconciliation.customers(tenant, q), tenant.correlationId);
  }

  @Get("reconciliation/rules")
  async rules(@CurrentTenant() tenant: TenantContext) {
    return success(await this.reconciliation.listRules(tenant), tenant.correlationId);
  }

  @Delete("reconciliation/rules/:id")
  async deleteRule(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.reconciliation.deleteRule(tenant, id), tenant.correlationId);
  }

  @Post("reconciliation/:lineId/match")
  @HttpCode(200)
  @Idempotent()
  async match(@CurrentTenant() tenant: TenantContext, @Param("lineId", ParseUUIDPipe) lineId: string, @Body() body: unknown) {
    return success(await this.reconciliation.reconcile(tenant, lineId, body), tenant.correlationId);
  }

  @Post("reconciliation/:lineId/undo")
  @HttpCode(200)
  async undo(@CurrentTenant() tenant: TenantContext, @Param("lineId", ParseUUIDPipe) lineId: string) {
    return success(await this.reconciliation.undo(tenant, lineId), tenant.correlationId);
  }
}
