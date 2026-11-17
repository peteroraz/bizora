import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { SyncHandlerRegistry } from "../sync/sync-handler.registry.js";
import { CustomerService } from "./customer.service.js";

/** Lets a device create a customer offline; the customer keeps the ID the device gave it. */
@Injectable()
export class CustomerSyncHandler implements OnModuleInit {
  constructor(
    @Inject(SyncHandlerRegistry) private readonly registry: SyncHandlerRegistry,
    @Inject(CustomerService) private readonly customers: CustomerService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "customer.create",
      anyOf: [Permission.CUSTOMERS_MANAGE, Permission.CUSTOMERS_ADD],
      handle: async (tenant, operation) => ({ customer: await this.customers.create(tenant, operation.payload) }),
    });
  }
}
