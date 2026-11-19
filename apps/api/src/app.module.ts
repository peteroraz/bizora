import { DynamicModule, Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import { CoreModule } from "./core.module.js";
import type { AppDatabase } from "./db/database.js";
import { AddressModule } from "./modules/addresses/address.module.js";
import { CustomersModule } from "./modules/customers/customer.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { EmailModule } from "./modules/email/email.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { RbacModule } from "./modules/rbac/rbac.module.js";
import { ReferenceModule } from "./modules/reference/reference.module.js";
import { DocumentsModule } from "./modules/documents/documents.module.js";
import { IdempotencyModule } from "./modules/idempotency/idempotency.module.js";
import { InventoryModule } from "./modules/inventory/inventory.module.js";
import { SalesModule } from "./modules/sales/sales.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { CaptureModule } from "./modules/capture/capture.module.js";
import { DebtorsModule } from "./modules/debtors/debtors.module.js";
import { MoneyModule } from "./modules/money/money.module.js";
import { ShopsModule } from "./modules/shops/shops.module.js";
import { WorkRulesModule } from "./modules/work-rules/work-rules.module.js";
import { SupplierModule } from "./modules/suppliers/supplier.module.js";
import { BrandingModule } from "./modules/branding/branding.module.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module.js";
import { LedgerModule } from "./modules/ledger/ledger.module.js";
import { StaffModule } from "./modules/staff/staff.module.js";
import { SyncModule } from "./modules/sync/sync.module.js";
import { TenantModule } from "./modules/tenant/tenant.module.js";

export type AppModuleOptions = {
  env: AppEnv;
  db: AppDatabase;
  logger: Logger;
};

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(options),
        EmailModule.register(),
        ThrottlerModule.forRoot({
          throttlers: [
            {
              ttl: options.env.THROTTLE_TTL_MS,
              limit: options.env.THROTTLE_AUTH_LIMIT,
            },
          ],
        }),
        AuditModule,
        HealthModule,
        TenantModule,
        IdentityModule,
        RbacModule,
        ReferenceModule,
        AddressModule,
        CustomersModule,
        StaffModule,
        IdempotencyModule,
        SyncModule,
        DocumentsModule,
        LedgerModule,
        InventoryModule,
        SalesModule,
        NotificationsModule,
        CaptureModule,
        DebtorsModule,
        MoneyModule,
        ShopsModule,
        WorkRulesModule,
        SupplierModule,
        ReconciliationModule,
    BrandingModule,
      ],
    };
  }
}
