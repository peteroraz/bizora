import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { DEBTOR_FILTERS, Permission, success } from "@bizora/contracts";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { PaymentService } from "./payment.service.js";

function pdfFile(pdf: Buffer, fileName: string) {
  return new StreamableFile(pdf, { type: "application/pdf", disposition: `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "")}"`, length: pdf.length });
}

/** Debtors: who owes what (debtors.read), taking payments (payments.record), cancelling them (debtors.manage). */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class PaymentController {
  constructor(@Inject(PaymentService) private readonly payments: PaymentService) {}

  @Get("debtors")
  @RequirePermissions(Permission.DEBTORS_READ)
  async debtors(@CurrentTenant() tenant: TenantContext, @Query("filter") filter?: string, @Query("q") q?: string, @Query("page") page?: string) {
    const chosen = DEBTOR_FILTERS.find((item) => item === filter) ?? "all";
    return success(await this.payments.debtors(tenant, { filter: chosen, ...(q ? { q } : {}), page: Number.parseInt(page ?? "1", 10) || 1 }), tenant.correlationId);
  }

  @Get("debtors/totals")
  @RequirePermissions(Permission.DEBTORS_READ)
  async totals(@CurrentTenant() tenant: TenantContext) {
    return success(await this.payments.totals(tenant), tenant.correlationId);
  }

  @Get("debtors/:customerId")
  @RequirePermissions(Permission.DEBTORS_READ)
  async account(@CurrentTenant() tenant: TenantContext, @Param("customerId", ParseUUIDPipe) customerId: string) {
    return success({ account: await this.payments.account(tenant, customerId) }, tenant.correlationId);
  }

  @Post("debtors/:customerId/payments")
  @RequirePermissions(Permission.PAYMENTS_RECORD)
  @Idempotent()
  async record(@CurrentTenant() tenant: TenantContext, @Param("customerId", ParseUUIDPipe) customerId: string, @Body() body: unknown) {
    return success({ payment: await this.payments.record(tenant, customerId, body) }, tenant.correlationId);
  }

  /** A new statement link; the old one stops working. */
  @Post("debtors/:customerId/statement-link")
  @HttpCode(200)
  @RequirePermissions(Permission.DEBTORS_MANAGE)
  async rotate(@CurrentTenant() tenant: TenantContext, @Param("customerId", ParseUUIDPipe) customerId: string) {
    return success({ account: await this.payments.rotateStatementLink(tenant, customerId) }, tenant.correlationId);
  }

  @Get("payments/:id")
  @RequirePermissions(Permission.DEBTORS_READ)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ payment: await this.payments.get(tenant, id) }, tenant.correlationId);
  }

  @Get("payments/:id/receipt")
  @RequirePermissions(Permission.DEBTORS_READ)
  async receipt(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    const { fileName, pdf } = await this.payments.document(tenant, id);
    return pdfFile(pdf, fileName);
  }

  @Post("payments/:id/void")
  @HttpCode(200)
  @RequirePermissions(Permission.DEBTORS_MANAGE)
  async void(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ payment: await this.payments.void(tenant, id, body) }, tenant.correlationId);
  }
}

/** A customer's statement, for anyone with the link sent on WhatsApp. */
@Controller("api/v1/public/statements")
export class PublicStatementController {
  constructor(@Inject(PaymentService) private readonly payments: PaymentService) {}

  @Get(":token")
  async statement(@Param("token") token: string) {
    return success({ statement: await this.payments.publicStatement(token) }, "public");
  }

  @Get(":token/pdf")
  async pdf(@Param("token") token: string) {
    const { fileName, pdf } = await this.payments.publicStatementPdf(token);
    return pdfFile(pdf, fileName);
  }

  @Get(":token/logo")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'")
  @Header("Cache-Control", "public, max-age=3600")
  async logo(@Param("token") token: string) {
    const logo = await this.payments.publicLogo(token);
    return new StreamableFile(logo.data, { type: logo.contentType, disposition: "inline", length: logo.data.length });
  }
}
