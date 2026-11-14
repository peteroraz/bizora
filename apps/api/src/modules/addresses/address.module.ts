import { Module } from "@nestjs/common";
import { AddressService } from "./address.service.js";

@Module({
  providers: [AddressService],
  exports: [AddressService],
})
export class AddressModule {}
