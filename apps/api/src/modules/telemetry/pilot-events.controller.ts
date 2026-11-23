import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { pilotEventsSchema } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { PilotEventsService } from "./pilot-events.service.js";

/** What happened on a phone during the pilot (ADR-045): names from a fixed list and short codes, nothing personal. */
@Controller("api/v1/telemetry")
@UseGuards(TenantGuard, ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PilotEventsController {
  constructor(@Inject(PilotEventsService) private readonly events: PilotEventsService) {}

  @Post("events")
  @HttpCode(204)
  async record(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const parsed = pilotEventsSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "These measures are not recognised.", 400);
    await this.events.record(tenant.tenantId, parsed.data.events);
  }
}
