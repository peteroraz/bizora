import { Module, forwardRef } from "@nestjs/common";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ChartOfAccountsService } from "./chart-of-accounts.service.js";
import { LedgerController } from "./ledger.controller.js";
import { LedgerPostingService } from "./ledger-posting.service.js";

@Module({
  imports: [forwardRef(() => TenantModule)],
  controllers: [LedgerController],
  providers: [ChartOfAccountsService, LedgerPostingService, PermissionGuard],
  exports: [ChartOfAccountsService, LedgerPostingService],
})
export class LedgerModule {}
