import { Inject, Injectable } from "@nestjs/common";
import { Permission, SUPPORT_VIEW_MINUTES, uuidSchema, type PermissionCode } from "@bizora/contracts";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import { supportAuditFields, type SupportActor } from "../../common/support-actor.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { adminSupportViews, auditEvents, branches, businesses, memberships, users } from "../../db/schema.js";
import { APP_ENV, DB, EMAIL } from "../../tokens.js";
import { publicWebOrigin, type AppEnv } from "@bizora/config/env";
import type { EmailPort } from "../email/email.port.js";
import { renderEmail } from "../email/templates.js";
import { AuditService } from "../audit/audit.service.js";
import { CustomerService } from "../customers/customer.service.js";
import { PaymentService } from "../debtors/payment.service.js";
import { ProductService } from "../inventory/product.service.js";
import { MoneyService } from "../money/money.service.js";
import { SaleService } from "../sales/sale.service.js";
import { FeatureService } from "../entitlements/feature.service.js";
import { AdminAuditService } from "./admin-audit.service.js";
import type { AdminStaffMember } from "./admin-session.service.js";

/** What the support view may read. Nothing that changes a record is ever called from here (ADR-039). */
const READ_ONLY: PermissionCode[] = [
  Permission.TENANT_READ,
  Permission.BRANCHES_READ,
  Permission.SALES_READ_ALL,
  Permission.STOCK_READ,
  Permission.PRICES_COST_READ,
  Permission.CUSTOMERS_READ,
  Permission.DEBTORS_READ,
  Permission.MONEY_READ,
  Permission.CASH_EXPECTED_READ,
  Permission.REPORTS_SALES_READ,
  Permission.REPORTS_STOCK_READ,
  Permission.REPORTS_PROFIT_READ,
];

export const SUPPORT_PAGES = ["sales", "sale", "stock", "customers", "debtors", "money", "activity"] as const;
export type SupportPage = (typeof SUPPORT_PAGES)[number];

const PERSONAL_KEYS = /^(phone|phoneE164|customerPhone|whatsapp|whatsappE164|email|customerEmail)$/;

/** Customers' phone numbers and emails are partly hidden from Bizora staff: 0803***567, a***@mail.com. */
export function maskPersonal(value: unknown, key = ""): unknown {
  if (typeof value === "string" && PERSONAL_KEYS.test(key)) {
    if (value.includes("@")) {
      const [name, domain] = value.split("@");
      return `${(name ?? "").slice(0, 1)}***@${domain ?? ""}`;
    }
    return value.length > 7 ? `${value.slice(0, 4)}***${value.slice(-3)}` : "***";
  }
  if (Array.isArray(value)) return value.map((item) => maskPersonal(item));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, maskPersonal(item, name)]));
  }
  return value;
}

/**
 * The support view (ADR-039): a Bizora staff member with records.read opens it on one business, with a reason, for
 * 60 minutes. Owners agree to this in the Terms of use, so no approval is asked each time. Every page read is written
 * to the staff log and to the business's own activity, where the owner sees it.
 */
@Injectable()
export class AdminRecordsService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AdminAuditService) private readonly adminAudit: AdminAuditService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SaleService) private readonly sales: SaleService,
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(CustomerService) private readonly customers: CustomerService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(MoneyService) private readonly money: MoneyService,
    @Inject(EMAIL) private readonly email: EmailPort,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(FeatureService) private readonly features: FeatureService,
  ) {}

  async open(staff: AdminStaffMember, tenantId: string, actor: SupportActor) {
    if (!uuidSchema.safeParse(tenantId).success) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    await this.features.assertOn(tenantId, "support_view");
    const owner = await this.owner(tenantId);
    const expiresAt = new Date(Date.now() + SUPPORT_VIEW_MINUTES * 60_000);
    const [view] = await this.db
      .insert(adminSupportViews)
      .values({ id: newId(), staffId: staff.staffId, tenantId, reason: actor.reason, expiresAt })
      .returning();
    await this.adminAudit.record({ staffId: staff.staffId, staffEmail: staff.email, action: "support.view_opened", targetType: "business", targetId: tenantId, tenantId, reason: actor.reason, metadata: { minutes: SUPPORT_VIEW_MINUTES }, ip: actor.ip ?? null });
    await this.audit.record({ ...supportAuditFields(actor), tenantId, action: "support.view_opened", entityType: "organization", entityId: tenantId, businessId: owner.businessId });
    await this.tellOwner(owner.userId, actor.reason, expiresAt);
    return this.present(view!);
  }

  async current(staff: AdminStaffMember, tenantId: string) {
    const view = await this.openView(staff, tenantId);
    return view ? this.present(view) : null;
  }

  async close(staff: AdminStaffMember, tenantId: string, ip: string | null) {
    const view = await this.openView(staff, tenantId);
    if (!view) return { closed: true };
    await this.db.update(adminSupportViews).set({ closedAt: new Date() }).where(eq(adminSupportViews.id, view.id));
    await this.adminAudit.record({ staffId: staff.staffId, staffEmail: staff.email, action: "support.view_closed", targetType: "business", targetId: tenantId, tenantId, ip });
    return { closed: true };
  }

  async read(staff: AdminStaffMember, tenantId: string, page: SupportPage, params: { businessId?: string | undefined; branchId?: string | undefined; id?: string | undefined; date?: string | undefined; q?: string | undefined; page?: string | undefined }, meta: { correlationId: string; ip: string | null; userAgent: string | null }) {
    const view = await this.openView(staff, tenantId);
    if (!view) throw new ApiError("SUPPORT_VIEW_CLOSED", "Open the support view first. It closes after an hour.", 403);
    // Switched off while a view was open: reading stops at once (ADR-045).
    await this.features.assertOn(tenantId, "support_view");
    const tenant = await this.context(tenantId, params.businessId, meta.correlationId);
    const pageNumber = Number.parseInt(params.page ?? "1", 10) || 1;
    const day = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : undefined;
    let data: unknown;
    switch (page) {
      case "sales":
        data = await this.sales.list(tenant, { ...(day ? { date: day } : {}), page: pageNumber });
        break;
      case "sale":
        if (!params.id || !uuidSchema.safeParse(params.id).success) throw new ApiError("NOT_FOUND", "Sale was not found.", 404);
        data = { sale: await this.sales.get(tenant, params.id) };
        break;
      case "stock":
        // Stock is per shop: the one asked for, or the business's first open shop.
        data = await this.products.list(tenant, { ...(params.q ? { q: params.q } : {}), page: pageNumber, branchId: await this.shop(tenantId, tenant.businessId, params.branchId) });
        break;
      case "customers":
        data = await this.customers.list(tenant, params.q ?? "", pageNumber);
        break;
      case "debtors":
        data = await this.payments.debtors(tenant, { filter: "all", page: pageNumber });
        break;
      case "money":
        data = {
          cash: await this.money.cashPosition(tenant, { ...(day ? { date: day } : {}) }),
          profit: await this.money.profit(tenant, { ...(day ? { from: day, to: day } : {}) }),
        };
        break;
      case "activity":
        data = await this.activity(tenantId);
        break;
    }
    const detail = { page, ...(params.branchId ? { branchId: params.branchId } : {}), ...(params.id ? { id: params.id } : {}), ...(day ? { date: day } : {}), ...(params.q ? { q: params.q } : {}) };
    await this.adminAudit.record({ staffId: staff.staffId, staffEmail: staff.email, action: "support.viewed", targetType: "business", targetId: tenantId, tenantId, reason: view.reason, metadata: detail, ip: meta.ip });
    await this.audit.record({
      ...supportAuditFields({ staffId: staff.staffId, staffEmail: staff.email, reason: view.reason, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent }),
      tenantId,
      action: "support.viewed",
      entityType: "organization",
      entityId: tenantId,
      businessId: tenant.businessId,
    });
    return { view: this.present(view), businessId: tenant.businessId, data: maskPersonal(data) };
  }

  private async activity(tenantId: string) {
    const rows = await this.db
      .select({ at: auditEvents.createdAt, action: auditEvents.action, entityType: auditEvents.entityType, actorType: auditEvents.actorType, actor: users.displayName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(eq(auditEvents.tenantId, tenantId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(100);
    return { items: rows.map((row) => ({ ...row, at: row.at.toISOString() })) };
  }

  private async shop(tenantId: string, businessId: string | null, asked: string | undefined) {
    const rows = await this.db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), ...(businessId ? [eq(branches.businessId, businessId)] : []), isNull(branches.closedAt)))
      .orderBy(asc(branches.createdAt));
    const chosen = rows.find((row) => row.id === asked) ?? rows[0];
    if (!chosen) throw new ApiError("BRANCH_REQUIRED", "This business has no open shop.", 400);
    return chosen.id;
  }

  private async openView(staff: AdminStaffMember, tenantId: string) {
    if (!uuidSchema.safeParse(tenantId).success) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const [view] = await this.db
      .select()
      .from(adminSupportViews)
      .where(and(eq(adminSupportViews.staffId, staff.staffId), eq(adminSupportViews.tenantId, tenantId), isNull(adminSupportViews.closedAt), gt(adminSupportViews.expiresAt, sql`now()`)))
      .orderBy(desc(adminSupportViews.openedAt))
      .limit(1);
    return view ?? null;
  }

  /**
   * The owner is told by email whenever Bizora staff open their records (ADR-042), as well as seeing it in Settings
   * › Bizora support. Sending never blocks the support view.
   */
  private async tellOwner(userId: string, reason: string, expiresAt: Date) {
    try {
      const [user] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.email) return;
      const rendered = renderEmail({
        title: "Bizora support is looking at your records",
        paragraphs: [
          `A member of Bizora support opened your business records, read-only, until ${expiresAt.toUTCString()}.`,
          `Reason given: ${reason}`,
          "Every page they open is listed in Settings › Bizora support. If you did not expect this, reply to Bizora support.",
        ],
        actionLabel: "See what support looked at",
        actionUrl: `${publicWebOrigin(this.env)}/app/settings`,
      });
      await this.email.send({ to: user.email, subject: "Bizora support opened your records", kind: "support_access", ...rendered });
    } catch {
      // The view is still logged for the owner in Settings.
    }
  }

  private async owner(tenantId: string) {
    if (!uuidSchema.safeParse(tenantId).success) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const [owner] = await this.db
      .select({ userId: memberships.userId, membershipId: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "OWNER")))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (!owner) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const [business] = await this.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.tenantId, tenantId)).orderBy(asc(businesses.createdAt)).limit(1);
    return { ...owner, businessId: business?.id ?? null };
  }

  /** Reads go through the app's own services, seen as the owner would see them, with read permissions only. */
  private async context(tenantId: string, businessId: string | undefined, correlationId: string): Promise<TenantContext> {
    const owner = await this.owner(tenantId);
    let chosen = owner.businessId;
    if (businessId && uuidSchema.safeParse(businessId).success) {
      const [match] = await this.db.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.tenantId, tenantId), eq(businesses.id, businessId))).limit(1);
      if (match) chosen = match.id;
    }
    return {
      userId: owner.userId,
      tenantId,
      businessId: chosen,
      branchId: null,
      membershipBusinessId: null,
      membershipBranchId: null,
      membershipId: owner.membershipId,
      role: "OWNER",
      permissions: READ_ONLY,
      correlationId,
      deviceId: null,
      actorType: "HUMAN",
    };
  }

  private present(view: typeof adminSupportViews.$inferSelect) {
    return { id: view.id, reason: view.reason, openedAt: view.openedAt.toISOString(), expiresAt: view.expiresAt.toISOString() };
  }
}
