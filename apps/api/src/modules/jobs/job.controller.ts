import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { JobService } from "./job.service.js";

/** Jobs for customers (ADR-035). Taking money and removing others' lines are checked in the service. */
@Controller("api/v1/jobs")
@UseGuards(TenantGuard, PermissionGuard)
export class JobController {
  constructor(@Inject(JobService) private readonly jobs: JobService) {}

  @Get()
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async list(@CurrentTenant() tenant: TenantContext, @Query("status") status?: string, @Query("customerId") customerId?: string, @Query("q") q?: string, @Query("page") page?: string) {
    return success(await this.jobs.list(tenant, { status, customerId, q, page: page ? Number.parseInt(page, 10) || 1 : 1 }), tenant.correlationId);
  }

  @Get("regulars")
  @RequirePermissions(Permission.SALES_CREATE)
  async regulars(@CurrentTenant() tenant: TenantContext) {
    return success(await this.jobs.regulars(tenant), tenant.correlationId);
  }

  @Get(":id")
  @RequireAnyPermission(Permission.SALES_CREATE, Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success(await this.jobs.get(tenant, id), tenant.correlationId);
  }

  @Post()
  @RequirePermissions(Permission.SALES_CREATE)
  @Idempotent()
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.jobs.create(tenant, body), tenant.correlationId);
  }

  @Patch(":id")
  @RequirePermissions(Permission.SALES_CREATE)
  async update(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.jobs.update(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/lines")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_CREATE)
  @Idempotent()
  async addLines(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.jobs.addLines(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/lines/:lineId/remove")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_CREATE)
  async removeLine(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("lineId", ParseUUIDPipe) lineId: string, @Body() body: unknown) {
    return success(await this.jobs.removeLine(tenant, id, lineId, body), tenant.correlationId);
  }

  @Post(":id/payments")
  @HttpCode(200)
  @RequireAnyPermission(Permission.PAYMENTS_RECORD, Permission.SALES_COLLECT)
  @Idempotent()
  async pay(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.jobs.pay(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/finish")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_CREATE)
  @Idempotent()
  async finish(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.jobs.finish(tenant, id, body), tenant.correlationId);
  }

  @Post(":id/cancel")
  @Idempotent()
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_CREATE)
  async cancel(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.jobs.cancel(tenant, id, body), tenant.correlationId);
  }
}
