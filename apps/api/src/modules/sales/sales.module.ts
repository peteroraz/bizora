import { BrandingModule } from "../branding/branding.module.js";
import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { InventoryModule } from "../inventory/inventory.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";
import { PublicReceiptController, SaleController } from "./sale.controller.js";
import { SaleSyncHandler } from "./sale-sync.handler.js";
import { ReturnService } from "./return.service.js";
import { SaleService } from "./sale.service.js";
import { SalesReportService } from "./sales-report.service.js";
import { QuickCatalogService } from "./quick-catalog.service.js";
import { SavedItemsController } from "./saved-items.controller.js";
import { UnitsController } from "./units.controller.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule, InventoryModule, NotificationsModule, BrandingModule],
  controllers: [SaleController, PublicReceiptController, ImportController, SavedItemsController, UnitsController],
  providers: [SaleService, ReturnService, SaleSyncHandler, ImportService, QuickCatalogService, SalesReportService, PermissionGuard],
  exports: [SaleService],
})
export class SalesModule {}
