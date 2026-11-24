import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { DiscountsReportService } from "./discounts-report.service.js";
import { MoneyService } from "./money.service.js";

/**
 * Money in and out (ADR-028). Recording expenses and money moves: expenses.record. Approving, rejecting and
 * cancelling: expenses.approve (whoever recorded an expense may cancel it while it waits). Counting a drawer:
 * cash.close. Seeing a drawer's expected cash: cash.expected.read. Profit: reports.profit.read.
 */
@Controller("api/v1/money")
@UseGuards(TenantGuard, PermissionGuard)
export class MoneyController {
  constructor(
    @Inject(MoneyService) private readonly money: MoneyService,
    @Inject(DiscountsReportService) private readonly report: DiscountsReportService,
  ) {}

  @Get("categories")
  @RequirePermissions(Permission.EXPENSES_RECORD)
  async categories(@CurrentTenant() tenant: TenantContext) {
    return success(await this.money.categories(tenant), tenant.correlationId);
  }

  @Get("expenses")
  @RequireAnyPermission(Permission.EXPENSES_RECORD, Permission.EXPENSES_APPROVE, Permission.MONEY_READ)
  async expenses(@CurrentTenant() tenant: TenantContext, @Query("from") from?: string, @Query("to") to?: string, @Query("status") status?: string) {
    return success(await this.money.listExpenses(tenant, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(status ? { status } : {}) }), tenant.correlationId);
  }

  @Get("expenses/waiting")
  @RequirePermissions(Permission.EXPENSES_APPROVE)
  async waiting(@CurrentTenant() tenant: TenantContext) {
    return success(await this.money.waitingCount(tenant), tenant.correlationId);
  }

  @Post("expenses")
  @RequirePermissions(Permission.EXPENSES_RECORD)
  @Idempotent()
  async record(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ expense: await this.money.recordExpense(tenant, body) }, tenant.correlationId);
  }

  @Post("expenses/:id/approve")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.EXPENSES_APPROVE)
  async approve(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ expense: await this.money.approveExpense(tenant, id) }, tenant.correlationId);
  }

  @Post("expenses/:id/void")
  @Idempotent()
  @HttpCode(200)
  @RequireAnyPermission(Permission.EXPENSES_RECORD, Permission.EXPENSES_APPROVE)
  async voidExpense(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ expense: await this.money.voidExpense(tenant, id, body) }, tenant.correlationId);
  }

  @Post("movements")
  @RequirePermissions(Permission.EXPENSES_RECORD)
  @Idempotent()
  async move(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ movement: await this.money.recordMovement(tenant, body) }, tenant.correlationId);
  }

  /**
   * What the drawer should hold, for the shop this person works in (ADR-053).
   * The cash-out screen uses it to ask before giving out more than that. The cash page stays behind cash.expected.read.
   */
  @Get("drawer-expected")
  @RequirePermissions(Permission.SALES_COLLECT)
  async drawerExpected(@CurrentTenant() tenant: TenantContext) {
    return success(await this.money.drawerExpected(tenant), tenant.correlationId);
  }

  /** POS cash-out (ADR-038): whoever takes money at the counter can record it. The server still records an amount above the drawer. */
  @Post("pos-cashouts")
  @RequirePermissions(Permission.SALES_COLLECT)
  @Idempotent()
  async posCashout(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ movement: await this.money.recordPosCashout(tenant, body) }, tenant.correlationId);
  }

  @Post("movements/:id/void")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.EXPENSES_APPROVE)
  async voidMove(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ movement: await this.money.voidMovement(tenant, id, body) }, tenant.correlationId);
  }

  @Get("cash")
  @RequirePermissions(Permission.CASH_EXPECTED_READ)
  async cash(@CurrentTenant() tenant: TenantContext, @Query("date") date?: string, @Query("branchId") branchId?: string) {
    return success(await this.money.cashPosition(tenant, { ...(date ? { date } : {}), ...(branchId ? { branchId } : {}) }), tenant.correlationId);
  }

  @Post("cash-counts")
  @RequirePermissions(Permission.CASH_CLOSE)
  @Idempotent()
  async count(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ count: await this.money.countCash(tenant, body) }, tenant.correlationId);
  }

  /** Discounts and cancellations (ADR-031): who gave money away at the counter, for a day or a month. */
  @Get("discounts-cancellations")
  @RequirePermissions(Permission.REPORTS_PROFIT_READ)
  async discountsCancellations(@CurrentTenant() tenant: TenantContext, @Query("from") from?: string, @Query("to") to?: string, @Query("branchId") branchId?: string) {
    return success(
      await this.report.report(tenant, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(branchId ? { branchId } : {}) }),
      tenant.correlationId,
    );
  }

  @Get("profit")
  @RequirePermissions(Permission.REPORTS_PROFIT_READ)
  async profit(@CurrentTenant() tenant: TenantContext, @Query("from") from?: string, @Query("to") to?: string, @Query("branchId") branchId?: string) {
    return success(
      await this.money.profit(tenant, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(branchId ? { branchId } : {}) }),
      tenant.correlationId,
    );
  }
}
