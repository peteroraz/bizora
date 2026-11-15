import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { SyncService } from "./sync.service.js";

@Controller("api/v1/sync")
@UseGuards(TenantGuard)
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  /** A device sends up to 50 queued operations. Each result says applied, duplicate (already applied) or rejected. */
  @Post("push")
  @HttpCode(200)
  async push(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.sync.push(tenant, body), tenant.correlationId);
  }
}
