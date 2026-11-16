import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequireAnyPermission, RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { SALE_DOCUMENT_TYPES, type SaleDocumentType } from "./sale-document.js";
import { SaleService } from "./sale.service.js";

/** Anyone who handles sales: the sales person (own), the cashier and store keeper (their desk), managers (all). */
const SEE_SALES = [Permission.SALES_READ_ALL, Permission.SALES_READ_OWN, Permission.SALES_COLLECT, Permission.SALES_RELEASE];

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
  @RequireAnyPermission(...SEE_SALES)
  async list(@CurrentTenant() tenant: TenantContext, @Query("date") date?: string, @Query("page") page?: string, @Query("status") status?: string) {
    return success(
      await this.sales.list(tenant, { ...(date ? { date } : {}), ...(status ? { status } : {}), page: Number.parseInt(page ?? "1", 10) || 1 }),
      tenant.correlationId,
    );
  }

  @Get("summary")
  @RequireAnyPermission(Permission.SALES_READ_ALL, Permission.SALES_READ_OWN)
  async summary(@CurrentTenant() tenant: TenantContext, @Query("date") date?: string) {
    return success(await this.sales.summary(tenant, date), tenant.correlationId);
  }

  @Get("queues")
  @RequireAnyPermission(Permission.SALES_CREATE, ...SEE_SALES)
  async queues(@CurrentTenant() tenant: TenantContext) {
    return success(await this.sales.queues(tenant), tenant.correlationId);
  }

  @Get(":id")
  @RequireAnyPermission(...SEE_SALES)
  async get(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string) {
    return success({ sale: await this.sales.get(tenant, id) }, tenant.correlationId);
  }

  /** The sale's invoice or receipt as a PDF (ADR-017). */
  @Get(":id/documents/:type")
  @RequireAnyPermission(...SEE_SALES)
  async document(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Param("type") type: string) {
    const { fileName, pdf } = await this.sales.document(tenant, id, documentType(type));
    return pdfFile(pdf, fileName);
  }

  /** Cashier: take the money, or give credit to an approved customer. */
  @Post(":id/collect")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_COLLECT)
  @Idempotent()
  async collect(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ sale: await this.sales.collect(tenant, id, body) }, tenant.correlationId);
  }

  /** Store keeper: the goods have been given out. */
  @Post(":id/release")
  @HttpCode(200)
  @RequirePermissions(Permission.SALES_RELEASE)
  @Idempotent()
  async release(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ sale: await this.sales.release(tenant, id, body) }, tenant.correlationId);
  }

  @Post(":id/comments")
  @HttpCode(200)
  @RequireAnyPermission(...SEE_SALES)
  @Idempotent()
  async comment(@CurrentTenant() tenant: TenantContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success({ sale: await this.sales.comment(tenant, id, body) }, tenant.correlationId);
  }

  /** Managers cancel any sale; a sales person may cancel their own while it still waits for payment. */
  @Post(":id/void")
  @HttpCode(200)
  @RequireAnyPermission(Permission.SALES_VOID, Permission.SALES_CREATE)
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

  @Get(":token/documents/:type")
  async document(@Param("token") token: string, @Param("type") type: string) {
    const { fileName, pdf } = await this.sales.publicDocument(token, documentType(type));
    return pdfFile(pdf, fileName);
  }
}

function documentType(type: string): SaleDocumentType {
  const found = SALE_DOCUMENT_TYPES.find((item) => item === type.replace(/\.pdf$/, ""));
  if (!found) throw new ApiError("NOT_FOUND", "Document not found.", 404);
  return found;
}

/** Shown in the browser, and saved under a readable name. Never cached: a sale can be cancelled later. */
function pdfFile(pdf: Buffer, fileName: string) {
  return new StreamableFile(pdf, { type: "application/pdf", disposition: `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "")}"`, length: pdf.length });
}
