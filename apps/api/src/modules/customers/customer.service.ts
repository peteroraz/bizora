import { Inject, Injectable } from "@nestjs/common";
import {
  CUSTOMER_PAGE_SIZE,
  customerClientIdSchema,
  LOOKUP_MIN_QUERY,
  LOOKUP_RESULT_LIMIT,
  Permission,
  customerImportSchema,
  customerNoteSchema,
  customerWriteSchema,
  followupCreateSchema,
  followupUpdateSchema,
  formatAddressDisplay,
  normalizePhoneToE164,
  parseCustomerCsv,
  type PermissionCode,
} from "@bizora/contracts";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { zonedDateTime, zonedDayBounds } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import {
  addresses,
  businesses,
  branches,
  customerFollowups,
  customerNotes,
  customers,
  memberships,
  subdivisions,
  users,
} from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AddressService } from "../addresses/address.service.js";
import { AuditService } from "../audit/audit.service.js";

type BusinessRow = typeof businesses.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;

function like(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

@Injectable()
export class CustomerService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AddressService) private readonly addressesService: AddressService,
  ) {}

  async dashboard(tenant: TenantContext) {
    const business = await this.requireBusiness(tenant);
    const canRead = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const bounds = zonedDayBounds(business.timezone.trim() || "Africa/Lagos");
    const scope = this.customerScope(tenant, business.id);
    const followupScope = this.followupScope(tenant, business.id);
    const [countRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(customers)
      .where(scope);
    const [overdueRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(customerFollowups)
      .where(and(followupScope, this.bucketFilter("overdue", bounds.start, bounds.end)));
    const due = await this.db
      .select({
        id: customerFollowups.id,
        customerId: customerFollowups.customerId,
        reason: customerFollowups.reason,
        dueAt: customerFollowups.dueAt,
        status: customerFollowups.status,
        customerName: customers.name,
      })
      .from(customerFollowups)
      .innerJoin(
        customers,
        and(eq(customers.tenantId, customerFollowups.tenantId), eq(customers.id, customerFollowups.customerId)),
      )
      .where(and(followupScope, this.bucketFilter("today", bounds.start, bounds.end)))
      .orderBy(asc(customerFollowups.dueAt))
      .limit(8);
    const [peopleRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.status, "ACTIVE")));
    const address = business.addressId ? await this.findAddress(tenant.tenantId, business.addressId) : null;
    const customerCount = canRead ? Number(countRow?.total ?? 0) : 0;
    // The setup checklist is for people who set up the shop; staff do not see it.
    const has = (code: PermissionCode) => tenant.permissions.includes(code);
    const checklist: { id: string; done: boolean; href: string }[] = [];
    if (has(Permission.BUSINESS_SETTINGS_MANAGE)) {
      checklist.push({
        id: "shop-place",
        done: Boolean(address?.city || address?.marketOrPlaza),
        href: "/app/settings?tab=shop",
      });
      if (has(Permission.CUSTOMERS_MANAGE)) checklist.push({ id: "first-customer", done: customerCount > 0, href: "/app/customers" });
      checklist.push({ id: "what-you-sell", done: Boolean(business.whatYouSell?.trim()), href: "/app/settings?tab=shop" });
      if (business.staffFeaturesEnabled && has(Permission.STAFF_MANAGE)) {
        checklist.push({
          id: "invite-staff",
          done: Number(peopleRow?.total ?? 0) > 1,
          href: "/app/staff",
        });
      }
      if (has(Permission.SALES_CREATE)) checklist.push({ id: "record-sale", done: false, href: "/app/sales" });
    }
    return {
      customerCount,
      overdueCount: canRead ? Number(overdueRow?.total ?? 0) : 0,
      followupsDueToday: canRead ? due.map((item) => ({ ...item, dueAt: item.dueAt.toISOString() })) : [],
      checklist,
      timezone: business.timezone.trim(),
      currency: business.baseCurrencyCode.trim(),
      businessName: business.name,
      profile: {
        businessType: business.businessType,
        otherCurrencies: business.otherCurrencies,
        staffCountBand: business.staffCountBand,
        branchCount: business.branchCount,
        whatYouSell: business.whatYouSell,
        multiCurrencyEnabled: business.multiCurrencyEnabled,
        staffFeaturesEnabled: business.staffFeaturesEnabled,
        visibleModules: business.visibleModules,
      },
    };
  }

  async list(tenant: TenantContext, query: string, page: number) {
    const business = await this.requireBusiness(tenant);
    if (!tenant.permissions.includes(Permission.CUSTOMERS_READ)) return this.lookup(tenant, business, query);
    const filters = [this.customerScope(tenant, business.id)];
    const needle = query.trim();
    if (needle) {
      const normalized = normalizePhoneToE164(needle, business.countryCode.trim());
      const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
      filters.push(
        or(
          sql`${customers.name} ILIKE ${like(needle)} ESCAPE '\\'`,
          normalized ? eq(customers.phoneE164, normalized) : sql`false`,
          digits.length >= 4 ? sql`${customers.phoneE164} ILIKE ${like(digits)} ESCAPE '\\'` : sql`false`,
        ),
      );
    }
    const where = and(...filters);
    const [countRow] = await this.db.select({ total: sql<number>`count(*)::int` }).from(customers).where(where);
    const total = Number(countRow?.total ?? 0);
    const safePage = Math.max(1, page);
    const items = await this.db
      .select()
      .from(customers)
      .where(where)
      .orderBy(asc(customers.name), asc(customers.id))
      .limit(CUSTOMER_PAGE_SIZE)
      .offset((safePage - 1) * CUSTOMER_PAGE_SIZE);
    return {
      mode: "list" as const,
      items: items.map((item) => this.summary(item)),
      page: safePage,
      pageSize: CUSTOMER_PAGE_SIZE,
      total,
    };
  }

  async get(tenant: TenantContext, id: string) {
    const customer = await this.requireCustomer(tenant, id);
    if (!tenant.permissions.includes(Permission.CUSTOMERS_READ)) return this.lookupSummary(customer);
    return this.present(tenant.tenantId, customer);
  }

  /**
   * Counter lookup for roles with customers.lookup only (cashier): find one customer to serve, never browse.
   * A name needs at least LOOKUP_MIN_QUERY letters; a phone number needs at least 7 digits. Returns a few fields only.
   */
  private async lookup(tenant: TenantContext, business: BusinessRow, query: string) {
    const needle = query.trim();
    const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
    const isPhone = /^[\d\s+()-]+$/.test(needle);
    if (needle.length < LOOKUP_MIN_QUERY || (isPhone && digits.length < 7)) {
      throw new ApiError(
        "SEARCH_TOO_SHORT",
        `Type at least ${LOOKUP_MIN_QUERY} letters of the name, or 7 digits of the phone number.`,
        400,
      );
    }
    const normalized = isPhone ? normalizePhoneToE164(needle, business.countryCode.trim()) : null;
    const match = isPhone
      ? or(
          normalized ? eq(customers.phoneE164, normalized) : sql`false`,
          sql`${customers.phoneE164} LIKE ${`%${digits}`}`,
        )
      : sql`${customers.name} ILIKE ${like(needle)} ESCAPE '\\'`;
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(this.customerScope(tenant, business.id), match))
      .orderBy(asc(customers.name), asc(customers.id))
      .limit(LOOKUP_RESULT_LIMIT);
    return {
      mode: "lookup" as const,
      items: rows.map((row) => this.lookupSummary(row)),
      page: 1,
      pageSize: LOOKUP_RESULT_LIMIT,
      total: rows.length,
    };
  }

  /** What a counter lookup may show: enough to pick the right person, nothing more (NDPA data minimisation). */
  private lookupSummary(row: CustomerRow) {
    return {
      id: row.id,
      name: row.name,
      isWalkIn: row.isWalkIn,
      phoneLast4: row.phoneE164 ? row.phoneE164.slice(-4) : null,
      limited: true as const,
    };
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = customerWriteSchema.parse(raw);
    const { id: clientId } = customerClientIdSchema.parse(raw ?? {});
    const business = await this.requireBusiness(tenant);
    const branch = await this.resolveBranch(tenant, business.id, payload.branchId);
    const phone = await this.normalize(payload, business);
    if (clientId) {
      const [taken] = await this.db.select().from(customers).where(eq(customers.id, clientId)).limit(1);
      // The same device sending the same new customer again (for example after a lost response): return it.
      if (taken && taken.tenantId === tenant.tenantId) return this.present(tenant.tenantId, taken);
      // IDs are global; never say whose record holds it.
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    if (phone) await this.assertPhoneAvailable(tenant.tenantId, business.id, phone, null);
    const id = clientId ?? newId();
    let addressId: string | null = null;
    await this.db.transaction(async (tx) => {
      if (payload.address) {
        const address = await this.addressesService.upsert(tenant, null, payload.address, tx);
        addressId = address.id;
      }
      await tx.insert(customers).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        name: payload.name,
        phoneE164: phone,
        isWalkIn: phone === null,
        email: this.email(payload.email),
        addressId,
        tags: payload.tags ?? [],
        notesSummary: this.summaryText(payload.notesSummary),
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "customer.created",
          entityType: "customer",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          branchId: branch.id,
        },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const existing = await this.requireCustomer(tenant, id);
    const payload = customerWriteSchema.parse(raw);
    const business = await this.requireBusiness(tenant);
    const branch = await this.resolveBranch(tenant, business.id, payload.branchId ?? existing.branchId ?? undefined);
    const phone = await this.normalize(payload, business);
    if (phone) await this.assertPhoneAvailable(tenant.tenantId, business.id, phone, existing.id);
    await this.db.transaction(async (tx) => {
      let addressId = existing.addressId;
      if (payload.address) {
        const address = await this.addressesService.upsert(tenant, existing.addressId, payload.address, tx);
        addressId = address.id;
      }
      await tx
        .update(customers)
        .set({
          name: payload.name,
          phoneE164: phone,
          isWalkIn: phone === null,
          email: this.email(payload.email),
          addressId,
          branchId: branch.id,
          tags: payload.tags ?? existing.tags,
          notesSummary:
            payload.notesSummary !== undefined ? this.summaryText(payload.notesSummary) : existing.notesSummary,
          updatedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(and(eq(customers.id, existing.id), eq(customers.tenantId, tenant.tenantId)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "customer.updated",
          entityType: "customer",
          entityId: existing.id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          branchId: branch.id,
        },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  async remove(tenant: TenantContext, id: string) {
    const existing = await this.requireCustomer(tenant, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(customers).where(and(eq(customers.id, existing.id), eq(customers.tenantId, tenant.tenantId)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "customer.deleted",
          entityType: "customer",
          entityId: existing.id,
          correlationId: tenant.correlationId,
          businessId: existing.businessId,
          branchId: existing.branchId,
        },
        tx,
      );
    });
    return { ok: true };
  }

  async listNotes(tenant: TenantContext, customerId: string) {
    await this.requireCustomer(tenant, customerId);
    const items = await this.db
      .select()
      .from(customerNotes)
      .where(and(eq(customerNotes.tenantId, tenant.tenantId), eq(customerNotes.customerId, customerId)))
      .orderBy(sql`${customerNotes.createdAt} DESC`);
    return items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }));
  }

  async addNote(tenant: TenantContext, customerId: string, raw: unknown) {
    const customer = await this.requireCustomer(tenant, customerId);
    const payload = customerNoteSchema.parse(raw);
    const id = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(customerNotes).values({
        id,
        tenantId: tenant.tenantId,
        businessId: customer.businessId,
        customerId: customer.id,
        body: payload.body,
        createdBy: tenant.userId,
      });
      await tx
        .update(customers)
        .set({ notesSummary: payload.body.slice(0, 2000), updatedAt: new Date(), updatedBy: tenant.userId })
        .where(and(eq(customers.id, customer.id), eq(customers.tenantId, tenant.tenantId)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "customer_note.created",
          entityType: "customer_note",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: customer.businessId,
          branchId: customer.branchId,
          metadata: { customerId: customer.id },
        },
        tx,
      );
    });
    return this.listNotes(tenant, customerId);
  }

  async listFollowups(tenant: TenantContext, bucket: string) {
    const business = await this.requireBusiness(tenant);
    const choice = bucket === "overdue" || bucket === "upcoming" || bucket === "today" ? bucket : "today";
    const bounds = zonedDayBounds(business.timezone.trim() || "Africa/Lagos");
    const rows = await this.db
      .select({
        id: customerFollowups.id,
        customerId: customerFollowups.customerId,
        reason: customerFollowups.reason,
        dueAt: customerFollowups.dueAt,
        status: customerFollowups.status,
        snoozedUntil: customerFollowups.snoozedUntil,
        assignedTo: customerFollowups.assignedTo,
        customerName: customers.name,
        customerPhone: customers.phoneE164,
      })
      .from(customerFollowups)
      .innerJoin(
        customers,
        and(eq(customers.tenantId, customerFollowups.tenantId), eq(customers.id, customerFollowups.customerId)),
      )
      .where(and(this.followupScope(tenant, business.id), this.bucketFilter(choice, bounds.start, bounds.end)))
      .orderBy(asc(customerFollowups.dueAt));
    return rows.map((row) => ({
      ...row,
      dueAt: row.dueAt.toISOString(),
      snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
      bucket: choice,
    }));
  }

  async createFollowup(tenant: TenantContext, customerId: string, raw: unknown) {
    const customer = await this.requireCustomer(tenant, customerId);
    const business = await this.requireBusiness(tenant);
    const payload = followupCreateSchema.parse(raw);
    const dueAt = payload.dueOn
      ? zonedDateTime(payload.dueOn, "17:00:00", business.timezone.trim() || "Africa/Lagos")
      : new Date(payload.dueAt ?? "");
    if (Number.isNaN(dueAt.getTime())) {
      throw new ApiError("VALIDATION_ERROR", "Choose a valid day.", 400);
    }
    const assignedTo = await this.resolveAssignee(tenant, payload.assignedTo);
    const id = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(customerFollowups).values({
        id,
        tenantId: tenant.tenantId,
        businessId: customer.businessId,
        customerId: customer.id,
        branchId: customer.branchId,
        dueAt,
        reason: payload.reason,
        assignedTo,
        status: "open",
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "followup.created",
          entityType: "customer_followup",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: customer.businessId,
          branchId: customer.branchId,
          metadata: { customerId: customer.id },
        },
        tx,
      );
    });
    return { id, dueAt: dueAt.toISOString() };
  }

  async updateFollowup(tenant: TenantContext, id: string, raw: unknown) {
    const payload = followupUpdateSchema.parse(raw);
    const business = await this.requireBusiness(tenant);
    const [existing] = await this.db
      .select()
      .from(customerFollowups)
      .where(and(eq(customerFollowups.id, id), this.followupScope(tenant, business.id)))
      .limit(1);
    if (!existing) throw new ApiError("FOLLOWUP_NOT_FOUND", "Follow-up was not found.", 404);
    const snoozedUntil =
      payload.status === "snoozed"
        ? payload.snoozedUntil
          ? new Date(payload.snoozedUntil)
          : new Date(Date.now() + (payload.snoozeDays ?? 1) * 24 * 60 * 60 * 1000)
        : null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(customerFollowups)
        .set({
          status: payload.status,
          snoozedUntil,
          ...(payload.reason ? { reason: payload.reason } : {}),
          updatedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(and(eq(customerFollowups.id, existing.id), eq(customerFollowups.tenantId, tenant.tenantId)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "followup.updated",
          entityType: "customer_followup",
          entityId: existing.id,
          correlationId: tenant.correlationId,
          businessId: existing.businessId,
          branchId: existing.branchId,
          metadata: { status: payload.status, customerId: existing.customerId },
        },
        tx,
      );
    });
    return { id: existing.id, status: payload.status };
  }

  async importCsv(tenant: TenantContext, raw: unknown) {
    const payload = customerImportSchema.parse(raw);
    const parsed = parseCustomerCsv(payload.csv);
    if (parsed.error) throw new ApiError("CSV_INVALID", parsed.error, 400);
    const business = await this.requireBusiness(tenant);
    const country = business.countryCode.trim();
    const preview: Array<{
      line: number;
      name: string;
      phone: string;
      email: string;
      notes: string;
      phoneE164: string | null;
      action: "create" | "update" | "error";
      errors: string[];
    }> = [];
    const normalized = parsed.rows.map((row) => ({
      row,
      phoneE164: row.phone ? normalizePhoneToE164(row.phone, country) : null,
    }));
    // One lookup for every phone in the file instead of one query per row.
    const existingByPhone = await this.findPhones(
      tenant.tenantId,
      business.id,
      normalized.flatMap((item) => (item.phoneE164 ? [item.phoneE164] : [])),
    );
    const seenInFile = new Set<string>();
    for (const { row, phoneE164 } of normalized) {
      const errors: string[] = [];
      if (!row.name) errors.push("Name is required.");
      if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push("Email is not valid.");
      if (!phoneE164) errors.push("Phone could not be read as a number for this country.");
      let action: "create" | "update" | "error" = errors.length > 0 ? "error" : "create";
      if (phoneE164 && errors.length === 0) {
        const existing = existingByPhone.get(phoneE164);
        if (existing && tenant.membershipBranchId && existing.branchId !== tenant.membershipBranchId) {
          errors.push("This phone is already used in another shop.");
          action = "error";
        } else if (existing || seenInFile.has(phoneE164)) {
          action = "update";
        }
        seenInFile.add(phoneE164);
      }
      preview.push({ ...row, phoneE164, action, errors });
    }
    let created = 0;
    let updated = 0;
    if (payload.commit) {
      const branch = await this.resolveBranch(tenant, business.id, tenant.branchId ?? undefined);
      await this.db.transaction(async (tx) => {
        const known = await this.findPhones(
          tenant.tenantId,
          business.id,
          preview.flatMap((row) => (row.action !== "error" && row.phoneE164 ? [row.phoneE164] : [])),
          tx,
        );
        for (const row of preview) {
          if (row.action === "error" || !row.phoneE164) continue;
          const existing = known.get(row.phoneE164) ?? null;
          if (existing && tenant.membershipBranchId && existing.branchId !== tenant.membershipBranchId) continue;
          if (existing) {
            await tx
              .update(customers)
              .set({
                name: row.name,
                email: row.email || null,
                notesSummary: row.notes || existing.notesSummary,
                updatedAt: new Date(),
                updatedBy: tenant.userId,
              })
              .where(and(eq(customers.id, existing.id), eq(customers.tenantId, tenant.tenantId)));
            if (row.notes && row.notes !== existing.notesSummary) {
              await tx.insert(customerNotes).values({
                id: newId(),
                tenantId: tenant.tenantId,
                businessId: business.id,
                customerId: existing.id,
                body: row.notes,
                createdBy: tenant.userId,
              });
            }
            updated += 1;
          } else {
            const id = newId();
            const [inserted] = await tx
              .insert(customers)
              .values({
                id,
                tenantId: tenant.tenantId,
                businessId: business.id,
                branchId: branch.id,
                name: row.name,
                phoneE164: row.phoneE164,
                isWalkIn: false,
                email: row.email || null,
                tags: [],
                notesSummary: row.notes || null,
                createdBy: tenant.userId,
                updatedBy: tenant.userId,
              })
              .returning();
            // A later row in the same file with this phone updates the customer just created.
            if (inserted) known.set(row.phoneE164, inserted);
            if (row.notes) {
              await tx.insert(customerNotes).values({
                id: newId(),
                tenantId: tenant.tenantId,
                businessId: business.id,
                customerId: id,
                body: row.notes,
                createdBy: tenant.userId,
              });
            }
            created += 1;
          }
        }
        await this.audit.record(
          {
            tenantId: tenant.tenantId,
            actorUserId: tenant.userId,
            action: "customer.imported",
            entityType: "customer",
            entityId: business.id,
            correlationId: tenant.correlationId,
            businessId: business.id,
            branchId: branch.id,
            metadata: { created, updated, errors: preview.filter((row) => row.action === "error").length },
          },
          tx,
        );
      });
    }
    return {
      rows: preview,
      created,
      updated,
      errors: preview.filter((row) => row.action === "error").length,
      committed: payload.commit,
    };
  }

  async assignees(tenant: TenantContext) {
    const business = await this.requireBusiness(tenant);
    const filters = [
      eq(memberships.tenantId, tenant.tenantId),
      eq(memberships.status, "ACTIVE"),
      or(isNull(memberships.businessId), eq(memberships.businessId, business.id)),
    ];
    if (tenant.membershipBranchId) {
      filters.push(or(isNull(memberships.branchId), eq(memberships.branchId, tenant.membershipBranchId)));
    }
    return this.db
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        displayName: users.displayName,
        branchId: memberships.branchId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...filters))
      .orderBy(asc(users.displayName));
  }

  private async requireBusiness(tenant: TenantContext) {
    if (!tenant.businessId) throw new ApiError("BUSINESS_REQUIRED", "Choose a business first.", 400);
    if (tenant.membershipBusinessId && tenant.membershipBusinessId !== tenant.businessId) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    const [business] = await this.db
      .select()
      .from(businesses)
      .where(and(eq(businesses.id, tenant.businessId), eq(businesses.tenantId, tenant.tenantId)))
      .limit(1);
    if (!business) throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    return business;
  }

  private customerScope(tenant: TenantContext, businessId: string) {
    const filters = [eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, businessId)];
    if (tenant.membershipBranchId) filters.push(eq(customers.branchId, tenant.membershipBranchId));
    return and(...filters);
  }

  private followupScope(tenant: TenantContext, businessId: string) {
    const filters = [eq(customerFollowups.tenantId, tenant.tenantId), eq(customerFollowups.businessId, businessId)];
    if (tenant.membershipBranchId) filters.push(eq(customerFollowups.branchId, tenant.membershipBranchId));
    // Sales staff see the follow-ups assigned to them or that they created; managers see all of them.
    if (!tenant.permissions.includes(Permission.FOLLOWUPS_READ_ALL)) {
      const own = or(eq(customerFollowups.assignedTo, tenant.membershipId), eq(customerFollowups.createdBy, tenant.userId));
      if (own) filters.push(own);
    }
    return and(...filters);
  }

  private bucketFilter(bucket: "today" | "overdue" | "upcoming", start: Date, end: Date) {
    if (bucket === "today") {
      return or(
        and(eq(customerFollowups.status, "open"), gte(customerFollowups.dueAt, start), lt(customerFollowups.dueAt, end)),
        and(
          eq(customerFollowups.status, "snoozed"),
          gte(customerFollowups.snoozedUntil, start),
          lt(customerFollowups.snoozedUntil, end),
        ),
      );
    }
    if (bucket === "overdue") {
      return or(
        and(eq(customerFollowups.status, "open"), lt(customerFollowups.dueAt, start)),
        and(eq(customerFollowups.status, "snoozed"), lt(customerFollowups.snoozedUntil, start)),
      );
    }
    return or(
      and(eq(customerFollowups.status, "open"), gte(customerFollowups.dueAt, end)),
      and(eq(customerFollowups.status, "snoozed"), gte(customerFollowups.snoozedUntil, end)),
    );
  }

  private async requireCustomer(tenant: TenantContext, id: string) {
    const business = await this.requireBusiness(tenant);
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), this.customerScope(tenant, business.id)))
      .limit(1);
    if (!row) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer was not found.", 404);
    return row;
  }

  private async resolveBranch(tenant: TenantContext, businessId: string, requested?: string) {
    const branchId = tenant.membershipBranchId ?? requested ?? tenant.branchId;
    if (!branchId) throw new ApiError("BRANCH_REQUIRED", "Choose a shop first.", 400);
    if (tenant.membershipBranchId && branchId !== tenant.membershipBranchId) {
      throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
    }
    const [branch] = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, businessId)))
      .limit(1);
    if (!branch) throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
    return branch;
  }

  private async normalize(payload: { isWalkIn?: boolean | undefined; phone?: string | undefined }, business: BusinessRow) {
    if (payload.isWalkIn) return null;
    const phone = normalizePhoneToE164(payload.phone ?? "", business.countryCode.trim());
    if (!phone) {
      throw new ApiError("VALIDATION_ERROR", "Enter a valid phone number.", 400, [
        { field: "phone", message: "Enter a valid phone number." },
      ]);
    }
    return phone;
  }

  private async assertPhoneAvailable(tenantId: string, businessId: string, phone: string, ignoreId: string | null) {
    const existing = await this.findPhone(tenantId, businessId, phone);
    if (existing && existing.id !== ignoreId) {
      throw new ApiError("DUPLICATE_PHONE", "This phone number is already saved for a customer.", 409, [
        { field: "phone", message: "This phone number is already saved for a customer." },
        { field: "customerId", message: existing.id },
      ]);
    }
  }

  private async findPhones(
    tenantId: string,
    businessId: string,
    phones: string[],
    store: Pick<AppDatabase, "select"> = this.db,
  ) {
    const found = new Map<string, typeof customers.$inferSelect>();
    const unique = [...new Set(phones)];
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      const rows = await store
        .select()
        .from(customers)
        .where(
          and(eq(customers.tenantId, tenantId), eq(customers.businessId, businessId), inArray(customers.phoneE164, chunk)),
        );
      for (const row of rows) {
        if (row.phoneE164 && !found.has(row.phoneE164)) found.set(row.phoneE164, row);
      }
    }
    return found;
  }

  private async findPhone(
    tenantId: string,
    businessId: string,
    phone: string,
    store: Pick<AppDatabase, "select"> = this.db,
  ) {
    const [row] = await store
      .select()
      .from(customers)
      .where(
        and(eq(customers.tenantId, tenantId), eq(customers.businessId, businessId), eq(customers.phoneE164, phone)),
      )
      .limit(1);
    return row ?? null;
  }

  private async resolveAssignee(tenant: TenantContext, requested?: string) {
    const membershipId = tenant.membershipBranchId ? tenant.membershipId : (requested ?? null);
    if (!membershipId) return null;
    const [membership] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenantId, tenant.tenantId),
          eq(memberships.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!membership) throw new ApiError("ASSIGNEE_NOT_FOUND", "That staff member was not found.", 400);
    return membership.id;
  }

  private email(value: string | null | undefined) {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  }

  private summaryText(value: string | null | undefined) {
    if (value === undefined) return null;
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  }

  private summary(row: CustomerRow) {
    return {
      id: row.id,
      name: row.name,
      phoneE164: row.phoneE164,
      isWalkIn: row.isWalkIn,
      email: row.email,
      tags: row.tags,
      notesSummary: row.notesSummary,
      branchId: row.branchId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async present(tenantId: string, row: CustomerRow) {
    const address = row.addressId ? await this.findAddress(tenantId, row.addressId) : null;
    let subdivisionName: string | null = null;
    if (address?.subdivisionCode) {
      const [subdivision] = await this.db
        .select()
        .from(subdivisions)
        .where(and(eq(subdivisions.countryCode, address.countryCode), eq(subdivisions.code, address.subdivisionCode)))
        .limit(1);
      subdivisionName = subdivision?.name ?? null;
    }
    return {
      ...this.summary(row),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: row.createdBy,
      address,
      addressFormatted: address
        ? formatAddressDisplay({
            shopNumber: address.shopNumber,
            lineOrBlock: address.lineOrBlock,
            marketOrPlaza: address.marketOrPlaza,
            line1: address.line1,
            city: address.city,
            subdivisionName,
          })
        : null,
    };
  }

  private async findAddress(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }
}
