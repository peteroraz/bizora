import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { SyncHandlerRegistry } from "../sync/sync-handler.registry.js";
import { StockService } from "./stock.service.js";

/** Stock in and stock counts can be recorded offline and synced later (Spec §7). */
@Injectable()
export class InventorySyncHandler implements OnModuleInit {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "stock.receive",
      anyOf: [Permission.STOCK_RECEIVE],
      handle: (tenant, operation) => this.stock.receive(tenant, operation.payload),
    });
    this.registry.register({
      type: "stock.count",
      anyOf: [Permission.STOCK_COUNT],
      handle: async (tenant, operation) => ({ count: await this.stock.count(tenant, operation.payload) }),
    });
  }
}
