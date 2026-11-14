import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { AddressService } from "./address.service.js";

@Controller("api/v1/addresses")
@UseGuards(TenantGuard)
export class AddressController {
  constructor(@Inject(AddressService) private readonly addresses: AddressService) {}

  @Post()
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const address = await this.addresses.create(tenant, body);
    return success({ address }, tenant.correlationId);
  }

  @Get(":id")
  async get(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const address = await this.addresses.get(tenant, id);
    return success({ address }, tenant.correlationId);
  }

  @Patch(":id")
  async update(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    const address = await this.addresses.update(tenant, id, body);
    return success({ address }, tenant.correlationId);
  }
}
