import { Inject, Injectable } from "@nestjs/common";
import { logoUploadSchema, updateBrandingSchema, type BrandingView, type LogoType } from "@bizora/contracts";
import { formatMoney } from "@bizora/money/format";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { canManageOrganizationSettings } from "../../common/tenant-scope.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, organizationLogos, organizations } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { brandFor, renderPdf, type BrandedDocument, type CompanyBranding, type DocumentBrand, type DocumentModel } from "../sales/sale-document.js";
import { inspectLogo, type LogoProblem } from "./logo-image.js";

const PROBLEM: Record<LogoProblem, string> = {
  not_image: "Choose a PNG or JPG picture.",
  too_big: "This picture is too big. Use one under 512 KB.",
  too_small: "This picture is too small. Use one at least 16 pixels wide and high.",
  too_large_pixels: "This picture is too large. Use one at most 2,000 pixels wide and high.",
  unreadable: "This picture cannot be printed on documents. Save it again as PNG or JPG and try again.",
};

/** Company branding: logo, colour and the texts printed on documents for customers (ADR-021). */
@Injectable()
export class BrandingService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async view(tenant: TenantContext): Promise<BrandingView> {
    const [row] = await this.db
      .select({
        primaryColor: organizations.primaryColor,
        receiptMessage: organizations.receiptMessage,
        invoiceMessage: organizations.invoiceMessage,
        documentTerms: organizations.documentTerms,
        logoType: organizationLogos.contentType,
        logoSha: organizationLogos.sha256,
        logoWidth: organizationLogos.width,
        logoHeight: organizationLogos.height,
        logoSize: organizationLogos.byteSize,
      })
      .from(organizations)
      .leftJoin(organizationLogos, eq(organizationLogos.tenantId, organizations.id))
      .where(eq(organizations.id, tenant.tenantId))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Organization not found.", 404);
    return {
      primaryColor: row.primaryColor,
      receiptMessage: row.receiptMessage,
      invoiceMessage: row.invoiceMessage,
      documentTerms: row.documentTerms,
      logo:
        row.logoSha && row.logoType
          ? { version: row.logoSha.slice(0, 12), contentType: row.logoType as LogoType, width: row.logoWidth ?? 0, height: row.logoHeight ?? 0, byteSize: row.logoSize ?? 0 }
          : null,
    };
  }

  async update(tenant: TenantContext, raw: unknown) {
    this.requireOrganizationWide(tenant);
    const payload = updateBrandingSchema.parse(raw);
    const text = (value: string | null | undefined) => (value === undefined ? undefined : value || null);
    const changes = {
      ...(payload.primaryColor ? { primaryColor: payload.primaryColor.toUpperCase() } : {}),
      ...(payload.accentColor ? { accentColor: payload.accentColor.toUpperCase() } : {}),
      ...(payload.receiptMessage !== undefined ? { receiptMessage: text(payload.receiptMessage) } : {}),
      ...(payload.invoiceMessage !== undefined ? { invoiceMessage: text(payload.invoiceMessage) } : {}),
      ...(payload.documentTerms !== undefined ? { documentTerms: text(payload.documentTerms) } : {}),
    };
    await this.db
      .update(organizations)
      .set({ ...changes, updatedBy: tenant.userId })
      .where(eq(organizations.id, tenant.tenantId));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "branding.updated",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
      metadata: { changed: Object.keys(changes) },
    });
    return this.view(tenant);
  }

  async uploadLogo(tenant: TenantContext, raw: unknown) {
    this.requireOrganizationWide(tenant);
    const payload = logoUploadSchema.parse(raw);
    const data = Buffer.from(payload.dataBase64, "base64");
    const checked = inspectLogo(data);
    if (typeof checked === "string") throw new ApiError("BAD_LOGO", PROBLEM[checked], 400, [{ field: "logo", message: PROBLEM[checked] }]);
    if (checked.contentType !== payload.contentType) throw new ApiError("BAD_LOGO", PROBLEM.not_image, 400, [{ field: "logo", message: PROBLEM.not_image }]);
    const values = { contentType: checked.contentType, data: checked.data, byteSize: checked.data.length, width: checked.width, height: checked.height, sha256: checked.sha256, updatedBy: tenant.userId, updatedAt: new Date() };
    await this.db
      .insert(organizationLogos)
      .values({ tenantId: tenant.tenantId, ...values })
      .onConflictDoUpdate({ target: organizationLogos.tenantId, set: values });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "branding.logo_updated",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
      metadata: { contentType: checked.contentType, width: checked.width, height: checked.height, byteSize: checked.data.length },
    });
    return this.view(tenant);
  }

  async removeLogo(tenant: TenantContext) {
    this.requireOrganizationWide(tenant);
    const removed = await this.db.delete(organizationLogos).where(eq(organizationLogos.tenantId, tenant.tenantId)).returning({ tenantId: organizationLogos.tenantId });
    if (removed.length > 0) {
      await this.audit.record({ tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "branding.logo_removed", entityType: "organization", entityId: tenant.tenantId, correlationId: tenant.correlationId });
    }
    return this.view(tenant);
  }

  async logo(tenant: TenantContext) {
    const [row] = await this.db.select().from(organizationLogos).where(eq(organizationLogos.tenantId, tenant.tenantId)).limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "There is no logo yet.", 404);
    return { contentType: row.contentType, data: row.data, etag: `"${row.sha256.slice(0, 16)}"` };
  }

  /** Branding for one kind of document, read in the same transaction or connection as the document. */
  async documentBrand(executor: DbExecutor, tenantId: string, kind: BrandedDocument): Promise<DocumentBrand> {
    return brandFor(await this.companyBranding(executor, tenantId), kind);
  }

  private async companyBranding(executor: DbExecutor, tenantId: string): Promise<CompanyBranding | null> {
    const [row] = await executor
      .select({
        primaryColor: organizations.primaryColor,
        receiptMessage: organizations.receiptMessage,
        invoiceMessage: organizations.invoiceMessage,
        documentTerms: organizations.documentTerms,
        logo: organizationLogos.data,
      })
      .from(organizations)
      .leftJoin(organizationLogos, eq(organizationLogos.tenantId, organizations.id))
      .where(eq(organizations.id, tenantId))
      .limit(1);
    return row ?? null;
  }

  /** A made-up receipt or invoice with the company's branding, to check how documents look before sending real ones. */
  async sample(tenant: TenantContext, kind: "receipt" | "invoice") {
    const [organization] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenant.tenantId)).limit(1);
    const [business] = tenant.businessId
      ? await this.db
          .select({ name: businesses.name, phone: businesses.phoneE164, currency: businesses.baseCurrencyCode, timezone: businesses.timezone })
          .from(businesses)
          .where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, tenant.businessId)))
          .limit(1)
      : [];
    const [branch] = tenant.branchId
      ? await this.db
          .select({ name: branches.name })
          .from(branches)
          .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, tenant.branchId)))
          .limit(1)
      : [];
    const currency = business?.currency.trim() ?? "NGN";
    const money = (minor: bigint) => formatMoney(minor, currency, "en-NG");
    const name = business?.name ?? organization?.name ?? "Your shop";
    const when = new Intl.DateTimeFormat("en-NG", { timeZone: business?.timezone ?? "Africa/Lagos", dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const title = kind === "receipt" ? "Receipt" : "Invoice";
    const model: DocumentModel = {
      type: kind,
      title,
      number: "SAMPLE",
      fileName: `${title}-SAMPLE.pdf`,
      shop: [name, branch && branch.name !== name ? branch.name : null, business?.phone ?? null].filter((value): value is string => Boolean(value)),
      details: [
        [`${title} no.`, "SAMPLE"],
        ["Date", when],
        ["Customer", "Sample customer"],
      ],
      lines: [
        { description: "Sample item", quantity: "2 pieces", price: money(150_000n), total: money(300_000n) },
        { description: "Another item", quantity: "1 piece", price: money(250_000n), total: money(250_000n) },
      ],
      totals: [["Total", money(550_000n), true]],
      notices: [{ text: "SAMPLE: this shows how your documents look. It is not a real sale.", tone: "info" }],
    };
    return { fileName: model.fileName, pdf: await renderPdf(model, await this.documentBrand(this.db, tenant.tenantId, kind)) };
  }

  private requireOrganizationWide(tenant: TenantContext) {
    if (!canManageOrganizationSettings(tenant)) throw new ApiError("FORBIDDEN", "Company branding needs organization-wide access.", 403);
  }
}
