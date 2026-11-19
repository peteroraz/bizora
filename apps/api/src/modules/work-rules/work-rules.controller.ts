import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { WorkRulesService } from "./work-rules.service.js";

/** Shop locks, opening hours and permission to work outside them (ADR-034). Owner checks are in the service. */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class WorkRulesController {
  constructor(@Inject(WorkRulesService) private readonly rules: WorkRulesService) {}

  @Get("work-rules/status")
  async status(@CurrentTenant() tenant: TenantContext) {
    return success(await this.rules.status(tenant), tenant.correlationId);
  }

  @Get("work-rules")
  async settings(@CurrentTenant() tenant: TenantContext) {
    return success(await this.rules.settings(tenant), tenant.correlationId);
  }

  @Put("work-rules/hours")
  async setHours(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.rules.setHours(tenant, body), tenant.correlationId);
  }

  @Post("branches/:id/lock")
  @HttpCode(200)
  async lock(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.rules.lock(tenant, id, body ?? {}), tenant.correlationId);
  }

  @Post("branches/:id/unlock")
  @HttpCode(200)
  async unlock(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.rules.unlock(tenant, id), tenant.correlationId);
  }

  @Post("work-permits")
  @HttpCode(200)
  async grant(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.rules.grant(tenant, body), tenant.correlationId);
  }

  @Post("work-permits/:id/stop")
  @HttpCode(200)
  async revoke(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.rules.revoke(tenant, id), tenant.correlationId);
  }
}
