import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { ChartOfAccountsService } from "./chart-of-accounts.service.js";
import { LedgerPostingService } from "./ledger-posting.service.js";

/** Read-only for now. Reports and the accountant screens come in Sprints 7 and 8.5. */
@Controller("api/v1/ledger")
@UseGuards(TenantGuard, PermissionGuard)
export class LedgerController {
  constructor(
    @Inject(ChartOfAccountsService) private readonly chart: ChartOfAccountsService,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
  ) {}

  @Get("accounts")
  @RequirePermissions(Permission.MONEY_READ)
  async accounts(@CurrentTenant() tenant: TenantContext) {
    const accounts = await this.chart.list(tenant.tenantId, this.businessId(tenant));
    return success(
      {
        items: accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          type: account.accountType,
          role: account.role,
          branchId: account.branchId,
        })),
      },
      tenant.correlationId,
    );
  }

  @Get("trial-balance")
  @RequirePermissions(Permission.REPORTS_PROFIT_READ)
  async trialBalance(@CurrentTenant() tenant: TenantContext, @Query("asOf") asOf?: string) {
    const result = await this.ledger.trialBalance(tenant.tenantId, this.businessId(tenant), asOf || undefined);
    return success(
      {
        accounts: result.accounts.map((row) => ({
          code: row.code,
          name: row.name,
          type: row.type,
          debitMinor: row.debitMinor.toString(),
          creditMinor: row.creditMinor.toString(),
          balanceMinor: row.balanceMinor.toString(),
        })),
        totalDebitMinor: result.totalDebitMinor.toString(),
        totalCreditMinor: result.totalCreditMinor.toString(),
        balanced: result.balanced,
      },
      tenant.correlationId,
    );
  }

  private businessId(tenant: TenantContext) {
    if (!tenant.businessId) throw new ApiError("BUSINESS_REQUIRED", "Choose a business first.", 400);
    return tenant.businessId;
  }
}
