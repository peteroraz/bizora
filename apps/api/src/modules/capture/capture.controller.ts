import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { CaptureService } from "./capture.service.js";

const CAN_CAPTURE = [Permission.PRODUCTS_MANAGE, Permission.SALES_CREATE, Permission.STOCK_RECEIVE];

/** Photo, scan and voice capture into draft rows (ADR-018). Never saves records itself. */
@Controller("api/v1/captures")
@UseGuards(TenantGuard, PermissionGuard)
export class CaptureController {
  constructor(@Inject(CaptureService) private readonly captures: CaptureService) {}

  @Get("status")
  @RequireAnyPermission(...CAN_CAPTURE)
  async status(@CurrentTenant() tenant: TenantContext) {
    return success(await this.captures.status(tenant), tenant.correlationId);
  }

  @Post()
  @HttpCode(200)
  @RequireAnyPermission(...CAN_CAPTURE)
  async capture(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.captures.capture(tenant, body), tenant.correlationId);
  }
}
