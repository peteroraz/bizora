import { Controller, Get, Inject, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Permission } from "@bizora/contracts";
import type { Response } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { BusinessExportService } from "./business-export.service.js";

/** Download every record of the business (pilot readiness, item 14). Owner and administrators; recorded in the activity log. */
@Controller("api/v1/exports")
@UseGuards(TenantGuard, PermissionGuard)
export class ExportsController {
  constructor(@Inject(BusinessExportService) private readonly exports: BusinessExportService) {}

  @Get("business")
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @RequireAnyPermission(Permission.TENANT_MANAGE)
  async business(@CurrentTenant() tenant: TenantContext, @Res({ passthrough: true }) res: Response) {
    const { fileName, data } = await this.exports.build(tenant);
    res.setHeader("cache-control", "no-store");
    return new StreamableFile(data, { type: "application/zip", disposition: `attachment; filename="${fileName}"`, length: data.length });
  }
}
