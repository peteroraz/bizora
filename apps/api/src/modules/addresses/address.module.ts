import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module.js";
import { AddressController } from "./address.controller.js";
import { AddressService } from "./address.service.js";

@Module({
  imports: [TenantModule],
  controllers: [AddressController],
  providers: [AddressService],
})
export class AddressModule {}
