import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PilotEventsService } from "../telemetry/pilot-events.service.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { SyncService } from "./sync.service.js";

@Controller("api/v1/sync")
@UseGuards(TenantGuard)
export class SyncController {
  constructor(
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(PilotEventsService) private readonly measures: PilotEventsService,
  ) {}

  /** A device sends up to 50 queued operations. Each result says applied, duplicate (already applied) or rejected. */
  @Post("push")
  @HttpCode(200)
  async push(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const outcome = await this.sync.push(tenant, body);
    // Pilot measures (ADR-045): how offline work arrives. The kind of change and any refusal code, nothing else.
    const types = new Map(((body as { operations?: { id?: unknown; type?: unknown }[] }).operations ?? []).map((operation) => [operation.id, String(operation.type ?? "")]));
    await this.measures.record(
      tenant.tenantId,
      outcome.results.map((result) => ({
        name: `sync.${result.status}`,
        detail: result.status === "rejected" ? (result.error?.code ?? null) : (types.get(result.id) ?? null),
      })),
    );
    return success(outcome, tenant.correlationId);
  }
}
