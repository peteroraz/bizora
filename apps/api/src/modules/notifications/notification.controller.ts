import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { NotificationService } from "./notification.service.js";

/** Everyone signed in to an organization has their own notifications; nobody sees anyone else's. */
@Controller("api/v1/notifications")
@UseGuards(TenantGuard)
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return success(await this.notifications.list(tenant), tenant.correlationId);
  }

  @Post("read")
  @HttpCode(200)
  async read(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.notifications.markRead(tenant, body), tenant.correlationId);
  }
}
