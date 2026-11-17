import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { z } from "zod";
import { SyncHandlerRegistry } from "../sync/sync-handler.registry.js";
import { PaymentService } from "./payment.service.js";

const offlinePayment = z.object({ customerId: z.string().uuid() }).passthrough();

/** Debtor payments taken with no network sync here, once (ADR-012, ADR-019). */
@Injectable()
export class PaymentSyncHandler implements OnModuleInit {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(PaymentService) private readonly payments: PaymentService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "payment.record",
      anyOf: [Permission.PAYMENTS_RECORD],
      handle: async (tenant, operation) => {
        const { customerId, ...payment } = offlinePayment.parse(operation.payload);
        return { payment: await this.payments.record(tenant, customerId, payment, { source: "offline" }) };
      },
    });
  }
}
