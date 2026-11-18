import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { ShopService } from "./shop.service.js";

/** Closing shops (owners only) and default shops (ADR-032). Checks are in the service. */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class ShopController {
  constructor(@Inject(ShopService) private readonly shops: ShopService) {}

  @Get("branches/:id/closing")
  async closing(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.shops.closingCheck(tenant, id), tenant.correlationId);
  }

  @Post("branches/:id/close")
  @HttpCode(200)
  async close(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.shops.close(tenant, id, body), tenant.correlationId);
  }

  @Put("memberships/:id/default-shop")
  async defaultShop(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.shops.setDefaultShop(tenant, id, body), tenant.correlationId);
  }
}
