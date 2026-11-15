import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { SyncHandlerRegistry } from "../sync/sync-handler.registry.js";
import { SaleService } from "./sale.service.js";

/** Sales recorded with no network sync here; the server gives them their official receipt number. */
@Injectable()
export class SaleSyncHandler implements OnModuleInit {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(SaleService) private readonly sales: SaleService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "sale.create",
      anyOf: [Permission.SALES_CREATE],
      handle: async (tenant, operation) => ({ sale: await this.sales.create(tenant, operation.payload, { source: "offline" }) }),
    });
  }
}
