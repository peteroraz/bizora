import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { CatalogController } from "./catalog.controller.js";
import { CatalogService } from "./catalog.service.js";
import { InventoryController } from "./inventory.controller.js";
import { InventorySyncHandler } from "./inventory-sync.handler.js";
import { ProductPhotoService } from "./product-photo.service.js";
import { ProductService } from "./product.service.js";
import { StockRequestService } from "./stock-request.service.js";
import { StockService } from "./stock.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule, NotificationsModule],
  controllers: [InventoryController, CatalogController],
  providers: [ProductService, CatalogService, ProductPhotoService, StockService, StockRequestService, InventorySyncHandler, PermissionGuard],
  exports: [StockService, ProductService],
})
export class InventoryModule {}
