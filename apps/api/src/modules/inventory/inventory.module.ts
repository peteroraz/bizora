import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { CatalogController } from "./catalog.controller.js";
import { AttributeService } from "./attribute.service.js";
import { CatalogService } from "./catalog.service.js";
import { CountSessionService } from "./count-session.service.js";
import { BatchService } from "./batch.service.js";
import { InventoryController } from "./inventory.controller.js";
import { StockOperationsController } from "./stock-operations.controller.js";
import { TransferService } from "./transfer.service.js";
import { InventorySyncHandler } from "./inventory-sync.handler.js";
import { ProductPhotoService } from "./product-photo.service.js";
import { ProductService } from "./product.service.js";
import { SerialService } from "./serial.service.js";
import { StockRequestService } from "./stock-request.service.js";
import { StockService } from "./stock.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule, NotificationsModule],
  controllers: [InventoryController, CatalogController, StockOperationsController],
  providers: [BatchService, ProductService, CatalogService, TransferService, CountSessionService, ProductPhotoService, StockService, StockRequestService, InventorySyncHandler, PermissionGuard, AttributeService, SerialService],
  exports: [StockService, ProductService, SerialService],
})
export class InventoryModule {}
