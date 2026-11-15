import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { SaleService } from "./sale.service.js";

@Controller("api/v1/sales")
@UseGuards(TenantGuard, PermissionGuard)
export class SaleController {
  constructor(@Inject(SaleService) private readonly sales: SaleService) {}

  @Post()
  @RequirePermissions(Permission.SALES_CREATE)
  @Idempotent()
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ sale: await this.sales.create(tenant, body) }, tenant.correlationId);
  }

  @Get()
  @RequireAnyPermission(Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async list(@CurrentTenant() tenant: TenantContext, @Query("date") date?: string, @Query("page") page?: string) {
    return success(
      await this.sales.list(tenant, { ...(date ? { date } : {}), page: Number.parseInt(page ?? "1", 10) || 1 }),
      tenant.correlationId,
    );
  }

  @Get("summary")
  @RequireAnyPermission(Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async summary(@CurrentTenant() tenant: TenantContext, @Query("date") date?: string) {
    return success(await this.sales.summary(tenant, date), tenant.correlationId);
  }

  @Get(":id")
  @RequireAnyPermission(Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ sale: await this.sales.get(tenant, id) }, tenant.correlationId);
  }

  @Post(":id/void")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_VOID)
  async void(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ sale: await this.sales.void(tenant, id, body) }, tenant.correlationId);
  }
}

/** The receipt a customer opens from WhatsApp. No sign-in; the long random link is the only key. */
@Controller("api/v1/public/receipts")
export class PublicReceiptController {
  constructor(@Inject(SaleService) private readonly sales: SaleService) {}

  @Get(":token")
  async receipt(@Param("token") token: string) {
    return success({ receipt: await this.sales.publicReceipt(token) }, "public");
  }
}
