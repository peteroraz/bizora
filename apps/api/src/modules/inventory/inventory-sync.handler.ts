import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { SyncHandlerRegistry } from "../sync/sync-handler.registry.js";
import { CountSessionService } from "./count-session.service.js";
import { ProductService } from "./product.service.js";
import { StockService } from "./stock.service.js";

/**
 * Stock work that can be recorded offline and synced later (Spec §7, ADR-064): stock in, counts, new products, stock
 * taken off or added (a request when the person's changes need approval), and lines of a count session. A count
 * keeps the time it was made, so it is compared with the stock at that time.
 */
@Injectable()
export class InventorySyncHandler implements OnModuleInit {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(CountSessionService) private readonly counts: CountSessionService,
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
      handle: async (tenant, operation) => ({ count: await this.stock.count(tenant, operation.payload, { countedAt: new Date(operation.occurredAt) }) }),
    });
    this.registry.register({
      type: "product.create",
      anyOf: [Permission.PRODUCTS_MANAGE],
      handle: async (tenant, operation) => ({ product: await this.products.create(tenant, operation.payload) }),
    });
    this.registry.register({
      type: "stock.adjust",
      // A store keeper (stock.count) asks; it waits for a manager or owner (ADR-034), as at the counter.
      anyOf: [Permission.STOCK_ADJUST, Permission.STOCK_COUNT],
      handle: (tenant, operation) => this.stock.adjust(tenant, operation.payload),
    });
    this.registry.register({
      type: "stock.count_line",
      anyOf: [Permission.STOCK_COUNT],
      handle: async (tenant, operation) => {
        const { sessionId, ...line } = (operation.payload ?? {}) as { sessionId?: unknown };
        if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
          throw new ApiError("VALIDATION_ERROR", "Choose the count this line belongs to.", 400, [{ field: "sessionId", message: "Missing." }]);
        }
        return { count: await this.counts.count(tenant, sessionId, line, { countedAt: new Date(operation.occurredAt) }) };
      },
    });
  }
}
