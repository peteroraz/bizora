import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";

/** Closing shops and default shops (ADR-032). */
@Module({
  imports: [TenantModule, LedgerModule, InventoryModule],
  controllers: [ShopController],
  providers: [ShopService, PermissionGuard],
})
export class ShopsModule {}
