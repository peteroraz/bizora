import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { InventoryController } from "./inventory.controller.js";
import { InventorySyncHandler } from "./inventory-sync.handler.js";
import { ProductService } from "./product.service.js";
import { StockService } from "./stock.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule],
  controllers: [InventoryController],
  providers: [ProductService, StockService, InventorySyncHandler, PermissionGuard],
  exports: [StockService, ProductService],
})
export class InventoryModule {}
