import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { CustomerService } from "./customer.service.js";

@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class CustomersController {
  constructor(@Inject(CustomerService) private readonly customers: CustomerService) {}

  @Get("dashboard")
  async dashboard(@CurrentTenant() tenant: TenantContext) {
    return success(await this.customers.dashboard(tenant), tenant.correlationId);
  }

  @Get("customers/assignees")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async assignees(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.customers.assignees(tenant) }, tenant.correlationId);
  }

  @Post("customers/import")
  @RequirePermissions(Permission.CUSTOMERS_MANAGE)
  async importCsv(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success(await this.customers.importCsv(tenant, body), tenant.correlationId);
  }

  @Get("customers")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async list(@CurrentTenant() tenant: TenantContext, @Query("q") q?: string, @Query("page") page?: string) {
    const parsed = Number(page);
    return success(await this.customers.list(tenant, q ?? "", Number.isFinite(parsed) ? parsed : 1), tenant.correlationId);
  }

  @Post("customers")
  @RequirePermissions(Permission.CUSTOMERS_MANAGE)
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const customer = await this.customers.create(tenant, body);
    return success({ customer }, tenant.correlationId);
  }

  @Get("customers/:id/notes")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async notes(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    return success({ items: await this.customers.listNotes(tenant, id) }, tenant.correlationId);
  }

  @Post("customers/:id/notes")
  @RequirePermissions(Permission.CUSTOMERS_MANAGE)
  async addNote(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    return success({ items: await this.customers.addNote(tenant, id, body) }, tenant.correlationId);
  }

  @Get("customers/:id/followups")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async customerFollowups(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const items = (await this.customers.listFollowups(tenant, "today"))
      .concat(await this.customers.listFollowups(tenant, "overdue"))
      .concat(await this.customers.listFollowups(tenant, "upcoming"))
      .filter((item) => item.customerId === id);
    return success({ items }, tenant.correlationId);
  }

  @Post("customers/:id/followups")
  @RequirePermissions(Permission.FOLLOWUPS_MANAGE)
  async createFollowup(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    return success({ followup: await this.customers.createFollowup(tenant, id, body) }, tenant.correlationId);
  }

  @Get("customers/:id")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    return success({ customer: await this.customers.get(tenant, id) }, tenant.correlationId);
  }

  @Patch("customers/:id")
  @RequirePermissions(Permission.CUSTOMERS_MANAGE)
  async update(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    return success({ customer: await this.customers.update(tenant, id, body) }, tenant.correlationId);
  }

  @Delete("customers/:id")
  @RequirePermissions(Permission.CUSTOMERS_MANAGE)
  async remove(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    return success(await this.customers.remove(tenant, id), tenant.correlationId);
  }

  @Get("followups")
  @RequirePermissions(Permission.CUSTOMERS_READ)
  async followups(@CurrentTenant() tenant: TenantContext, @Query("bucket") bucket?: string) {
    return success({ items: await this.customers.listFollowups(tenant, bucket ?? "today") }, tenant.correlationId);
  }

  @Patch("followups/:id")
  @RequirePermissions(Permission.FOLLOWUPS_MANAGE)
  async updateFollowup(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Body() body: unknown) {
    return success({ followup: await this.customers.updateFollowup(tenant, id, body) }, tenant.correlationId);
  }
}
