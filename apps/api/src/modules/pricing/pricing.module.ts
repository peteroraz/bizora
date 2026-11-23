import { Module } from "@nestjs/common";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { InventoryModule } from "../inventory/inventory.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { PricingController } from "./pricing.controller.js";
import { PricingService } from "./pricing.service.js";
import { StockReceiptService } from "./stock-receipt.service.js";

/** Price lists, suppliers per product and deliveries with charges (ADR-048). */
@Module({
  imports: [TenantModule, IdempotencyModule, InventoryModule],
  controllers: [PricingController],
  providers: [PricingService, StockReceiptService, PermissionGuard],
})
export class PricingModule {}
