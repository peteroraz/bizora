import { Inject, Injectable } from "@nestjs/common";
import {
  checkPhone,
  moneyReasonSchema,
  Permission,
  phoneProblemMessage,
  supplierOpeningSchema,
  supplierPaymentSchema,
  supplierSchema,
  supplierUpdateSchema,
  type SupplierEntryKind,
  type SupplierPaidFrom,
} from "@bizora/contracts";
import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, products, stockMovements, supplierEntries, suppliers, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness, resolveBranch } from "../inventory/inventory-scope.js";
import { LedgerPostingService, type AccountRef } from "../ledger/ledger-posting.service.js";

type Business = typeof businesses.$inferSelect;
type Supplier = typeof suppliers.$inferSelect;
type Entry = { kind: string; amountMinor: bigint; entryDate: string; payBy: string | null };

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const adds = (kind: string) => kind === "purchase" || kind === "opening";

/**
 * What is owed to a supplier and how much of it is late. Payments settle the oldest amounts first, so the amounts
 * still owed are the newest; one of those is late when its pay-by day has passed.
 */
export function owedOf(entries: Entry[], today: string) {
  let owed = 0n;
  let paid = 0n;
  const debts = entries.filter((entry) => adds(entry.kind)).sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
  for (const entry of entries) {
    if (adds(entry.kind)) owed += entry.amountMinor;
    else paid += entry.amountMinor;
  }
  let settled = paid;
  let overdue = 0n;
  let nextPayBy: string | null = null;
  for (const debt of debts) {
    const left = debt.amountMinor > settled ? debt.amountMinor - settled : 0n;
    settled = settled > debt.amountMinor ? settled - debt.amountMinor : 0n;
    if (left === 0n || !debt.payBy) continue;
    if (debt.payBy < today) overdue += left;
    else if (!nextPayBy || debt.payBy < nextPayBy) nextPayBy = debt.payBy;
  }
  return { owedMinor: owed - paid, overdueMinor: overdue, nextPayBy };
}

/**
 * Suppliers and what is owed to them (ADR-029). Paying a supplier posts Dr "Suppliers we owe" Cr cash, bank or the
 * owner's money; an amount owed from before Bizora posts Dr the owner's money put in Cr "Suppliers we owe". Stock
 * bought on credit already credited "Suppliers we owe" when it came in (supplier-ledger.ts).
 */
@Injectable()
export class SupplierService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Names only, for choosing a supplier on stock in (storekeepers see no money). */
  async names(tenant: TenantContext, query: string | undefined) {
    const business = await requireBusiness(this.db, tenant);
    const filters: SQL[] = [eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, business.id), isNull(suppliers.archivedAt), eq(suppliers.unnamed, false)];
    const needle = (query ?? "").trim();
    if (needle) filters.push(ilike(suppliers.name, `%${needle.replace(/[%_\\]/g, "\\$&")}%`));
    const rows = await this.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(and(...filters)).orderBy(asc(suppliers.name)).limit(50);
    return { items: rows };
  }

  /** Every supplier with what is owed, what is late and when the next payment is due; the biggest debts first. */
  async list(tenant: TenantContext, query: { q?: string; archived?: boolean }) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const filters: SQL[] = [eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, business.id)];
    filters.push(query.archived ? sql`${suppliers.archivedAt} IS NOT NULL` : isNull(suppliers.archivedAt));
    const needle = (query.q ?? "").trim();
    if (needle) filters.push(ilike(suppliers.name, `%${needle.replace(/[%_\\]/g, "\\$&")}%`));
    const rows = await this.db.select().from(suppliers).where(and(...filters)).orderBy(asc(suppliers.name)).limit(500);
    const entries = await this.entriesFor(this.db, tenant.tenantId, rows.map((row) => row.id));
    const [lastBought] = await Promise.all([this.lastPurchases(tenant.tenantId, rows.map((row) => row.id))]);
    let totalOwed = 0n;
    let totalOverdue = 0n;
    const items = rows
      .map((row) => {
        const figures = owedOf(entries.get(row.id) ?? [], today);
        totalOwed += figures.owedMinor;
        totalOverdue += figures.overdueMinor;
        return {
          ...this.view(row),
          owedMinor: figures.owedMinor.toString(),
          overdueMinor: figures.overdueMinor.toString(),
          nextPayBy: figures.nextPayBy,
          lastBoughtAt: lastBought.get(row.id) ?? null,
        };
      })
      // The unnamed one only shows while something is owed under it.
      .filter((item) => !item.unnamed || item.owedMinor !== "0")
      .sort((a, b) => {
        const difference = BigInt(b.owedMinor) - BigInt(a.owedMinor);
        return difference > 0n ? 1 : difference < 0n ? -1 : a.name.localeCompare(b.name);
      });
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      owedMinor: totalOwed.toString(),
      overdueMinor: totalOverdue.toString(),
      owing: items.filter((item) => item.owedMinor !== "0").length,
      items,
    };
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = supplierSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const phone = this.phone(payload.phone, business);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, business.id), sql`lower(${suppliers.name}) = lower(${payload.name})`))
        .limit(1);
      if (clash) throw new ApiError("SUPPLIER_EXISTS", "You already have a supplier with this name.", 409, [{ field: "name", message: "Already on your list." }]);
      await tx.insert(suppliers).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        name: payload.name,
        phoneE164: phone,
        notes: payload.notes || null,
        createdBy: tenant.userId,
      });
      await this.record(tx, tenant, business.id, null, "supplier.created", id, { name: payload.name });
    });
    return this.detail(tenant, id);
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const payload = supplierUpdateSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const supplier = await this.requireSupplier(this.db, tenant, business.id, id);
    if (supplier.unnamed && payload.name) throw new ApiError("UNNAMED_SUPPLIER", "This one collects stock bought with no supplier named; it cannot be renamed.", 409);
    if (payload.archived && owedOf((await this.entriesFor(this.db, tenant.tenantId, [id])).get(id) ?? [], localDate(new Date(), business.timezone)).owedMinor !== 0n) {
      throw new ApiError("SUPPLIER_OWED", "You still owe this supplier. Pay them first, then remove them.", 409);
    }
    const changes: Partial<Supplier> = { updatedAt: new Date() };
    if (payload.name) changes.name = payload.name;
    if (payload.phone !== undefined) changes.phoneE164 = payload.phone ? this.phone(payload.phone, business) : null;
    if (payload.notes !== undefined) changes.notes = payload.notes || null;
    if (payload.archived !== undefined) changes.archivedAt = payload.archived ? new Date() : null;
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(suppliers).set(changes).where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.id, id)));
        await this.record(tx, tenant, business.id, null, "supplier.updated", id, { fields: Object.keys(payload) });
      });
    } catch (failure) {
      if ((failure as { code?: string }).code === "23505") {
        throw new ApiError("SUPPLIER_EXISTS", "You already have a supplier with this name.", 409, [{ field: "name", message: "Already on your list." }]);
      }
      throw failure;
    }
    return this.detail(tenant, id);
  }

  /** A supplier with what is owed and every line, newest first: deliveries (with what came), payments, amounts from before. */
  async detail(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const supplier = await this.requireSupplier(this.db, tenant, business.id, id);
    const today = localDate(new Date(), business.timezone);
    const figures = owedOf((await this.entriesFor(this.db, tenant.tenantId, [id])).get(id) ?? [], today);
    const lines = await this.db
      .select({
        id: supplierEntries.id,
        kind: supplierEntries.kind,
        amountMinor: sql<string>`${supplierEntries.amountMinor}::text`,
        entryDate: supplierEntries.entryDate,
        payBy: supplierEntries.payBy,
        paidFrom: supplierEntries.paidFrom,
        note: supplierEntries.note,
        status: supplierEntries.status,
        voidReason: supplierEntries.voidReason,
        shop: branches.name,
        by: users.displayName,
        product: products.name,
        quantity: stockMovements.enteredQuantity,
        unit: stockMovements.enteredUnit,
        documentNumber: stockMovements.documentNumber,
        createdAt: supplierEntries.createdAt,
      })
      .from(supplierEntries)
      .leftJoin(branches, and(eq(branches.tenantId, supplierEntries.tenantId), eq(branches.id, supplierEntries.branchId)))
      .leftJoin(users, eq(users.id, supplierEntries.createdBy))
      .leftJoin(stockMovements, and(eq(stockMovements.tenantId, supplierEntries.tenantId), eq(stockMovements.id, supplierEntries.stockMovementId)))
      .leftJoin(products, and(eq(products.tenantId, stockMovements.tenantId), eq(products.id, stockMovements.productId)))
      .where(and(eq(supplierEntries.tenantId, tenant.tenantId), eq(supplierEntries.supplierId, id)))
      .orderBy(desc(supplierEntries.entryDate), desc(supplierEntries.createdAt))
      .limit(200);
    // Deliveries paid in cash or by bank owe nothing, but belong to the supplier's history.
    const paidDeliveries = await this.db
      .select({
        id: stockMovements.id,
        product: products.name,
        quantity: stockMovements.enteredQuantity,
        unit: stockMovements.enteredUnit,
        valueMinor: sql<string>`${stockMovements.valueMinor}::text`,
        paidFrom: stockMovements.paidFrom,
        documentNumber: stockMovements.documentNumber,
        occurredAt: stockMovements.occurredAt,
      })
      .from(stockMovements)
      .innerJoin(products, and(eq(products.tenantId, stockMovements.tenantId), eq(products.id, stockMovements.productId)))
      .where(
        and(
          eq(stockMovements.tenantId, tenant.tenantId),
          eq(stockMovements.supplierId, id),
          inArray(stockMovements.paidFrom, ["cash", "bank"]),
        ),
      )
      .orderBy(desc(stockMovements.occurredAt))
      .limit(50);
    const voids = tenant.permissions.includes(Permission.EXPENSES_APPROVE);
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      supplier: this.view(supplier),
      owedMinor: figures.owedMinor.toString(),
      overdueMinor: figures.overdueMinor.toString(),
      nextPayBy: figures.nextPayBy,
      entries: lines.map((line) => ({
        ...line,
        kind: line.kind as SupplierEntryKind,
        quantity: line.quantity === null ? null : line.quantity.toString(),
        createdAt: line.createdAt.toISOString(),
        // Deliveries are corrected through stock; payments and amounts from before can be cancelled by the owner.
        canCancel: voids && line.status === "recorded" && line.kind !== "purchase",
      })),
      paidDeliveries: paidDeliveries.map((delivery) => ({
        ...delivery,
        quantity: delivery.quantity.toString(),
        occurredAt: delivery.occurredAt.toISOString(),
      })),
    };
  }

  /** Pays a supplier: Dr "Suppliers we owe" Cr the drawer, the bank or the owner's money. Never more than is owed. */
  async pay(tenant: TenantContext, supplierId: string, raw: unknown) {
    const payload = supplierPaymentSchema.parse(raw);
    const id = payload.id ?? newId();
    if (payload.id && (await this.existingEntry(tenant, payload.id))) return this.detail(tenant, supplierId);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const supplier = await this.requireSupplier(tx, tenant, business.id, supplierId, true);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      const date = this.pastDay(payload.paymentDate, business);
      const amount = BigInt(payload.amountMinor);
      const owed = owedOf((await this.entriesFor(tx, tenant.tenantId, [supplierId])).get(supplierId) ?? [], date).owedMinor;
      if (amount > owed) {
        throw new ApiError("MORE_THAN_OWED", `That is more than you owe ${supplier.name}.`, 400, [{ field: "amountMinor", message: "More than you owe." }]);
      }
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: date,
          source: { type: "supplier_payment", id },
          postingKey: `supplier-payment:${id}`,
          description: `Paid ${supplier.name}${payload.note ? `: ${payload.note}` : ""}`.slice(0, 240),
          lines: [
            { account: { role: "payable" }, debitMinor: amount, memo: supplier.name.slice(0, 240) },
            { account: this.paidFromAccount(payload.paidFrom, branch.id), creditMinor: amount, memo: payload.paidFrom },
          ],
        },
      );
      await tx.insert(supplierEntries).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        supplierId,
        branchId: branch.id,
        kind: "payment",
        amountMinor: amount,
        currencyCode: business.baseCurrencyCode,
        entryDate: date,
        paidFrom: payload.paidFrom,
        note: payload.note || null,
        journalEntryId: posted.entryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
      });
      await this.record(tx, tenant, business.id, branch.id, "supplier.paid", supplierId, { entryId: id, amountMinor: amount.toString(), paidFrom: payload.paidFrom });
    });
    return this.detail(tenant, supplierId);
  }

  /** An amount already owed before Bizora: Dr the owner's money put in, Cr "Suppliers we owe". */
  async addOpening(tenant: TenantContext, supplierId: string, raw: unknown) {
    const payload = supplierOpeningSchema.parse(raw);
    const id = payload.id ?? newId();
    if (payload.id && (await this.existingEntry(tenant, payload.id))) return this.detail(tenant, supplierId);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const supplier = await this.requireSupplier(tx, tenant, business.id, supplierId, true);
      const date = localDate(new Date(), business.timezone);
      const amount = BigInt(payload.amountMinor);
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          entryDate: date,
          source: { type: "supplier_opening", id },
          postingKey: `supplier-opening:${id}`,
          description: `Already owed to ${supplier.name} before Bizora`.slice(0, 240),
          lines: [
            { account: { role: "capital" }, debitMinor: amount, memo: "Owed before Bizora" },
            { account: { role: "payable" }, creditMinor: amount, memo: supplier.name.slice(0, 240) },
          ],
        },
      );
      await tx.insert(supplierEntries).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        supplierId,
        kind: "opening",
        amountMinor: amount,
        currencyCode: business.baseCurrencyCode,
        entryDate: date,
        payBy: payload.payBy ?? null,
        note: payload.note || null,
        journalEntryId: posted.entryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
      });
      await this.record(tx, tenant, business.id, null, "supplier.opening_added", supplierId, { entryId: id, amountMinor: amount.toString() });
    });
    return this.detail(tenant, supplierId);
  }

  /** Cancels a payment or an amount from before: the entry is reversed, the line kept and marked cancelled. */
  async voidEntry(tenant: TenantContext, entryId: string, raw: unknown) {
    const { reason } = moneyReasonSchema.parse(raw);
    let supplierId = "";
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const [entry] = await tx
        .select()
        .from(supplierEntries)
        .where(and(eq(supplierEntries.tenantId, tenant.tenantId), eq(supplierEntries.businessId, business.id), eq(supplierEntries.id, entryId)))
        .for("update")
        .limit(1);
      if (!entry) throw new ApiError("NOT_FOUND", "Not found.", 404);
      supplierId = entry.supplierId;
      if (entry.kind === "purchase") {
        throw new ApiError("CORRECT_IN_STOCK", "A delivery is corrected in stock (remove the stock), not here.", 409);
      }
      if (entry.status === "voided") throw new ApiError("ALREADY_VOIDED", "This has already been cancelled.", 409);
      if (entry.kind === "opening") {
        const owed = owedOf((await this.entriesFor(tx, tenant.tenantId, [entry.supplierId])).get(entry.supplierId) ?? [], localDate(new Date(), business.timezone)).owedMinor;
        if (owed < entry.amountMinor) {
          throw new ApiError("PAID_ALREADY", "Part of this has been paid. Cancel the payment first.", 409);
        }
      }
      if (entry.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, entry.journalEntryId, {
          entryDate: localDate(new Date(), business.timezone),
          reason: `Cancelled: ${reason}`,
        });
      }
      await tx
        .update(supplierEntries)
        .set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason })
        .where(and(eq(supplierEntries.tenantId, tenant.tenantId), eq(supplierEntries.id, entryId)));
      await this.record(tx, tenant, business.id, entry.branchId, "supplier.entry_voided", entry.supplierId, { entryId, kind: entry.kind, reason });
    });
    return this.detail(tenant, supplierId);
  }

  /** What is owed to suppliers in total, for Money and Home. */
  async owedTotals(tenant: TenantContext) {
    const list = await this.list(tenant, {});
    return { currency: list.currency, owedMinor: list.owedMinor, overdueMinor: list.overdueMinor, owing: list.owing };
  }

  /* ------------------------------------------------------------------ helpers */

  private async entriesFor(executor: DbExecutor, tenantId: string, supplierIds: string[]) {
    const map = new Map<string, Entry[]>();
    if (supplierIds.length === 0) return map;
    const rows = await executor
      .select({
        supplierId: supplierEntries.supplierId,
        kind: supplierEntries.kind,
        amountMinor: supplierEntries.amountMinor,
        entryDate: supplierEntries.entryDate,
        payBy: supplierEntries.payBy,
      })
      .from(supplierEntries)
      .where(and(eq(supplierEntries.tenantId, tenantId), inArray(supplierEntries.supplierId, supplierIds), eq(supplierEntries.status, "recorded")));
    for (const row of rows) {
      const list = map.get(row.supplierId) ?? [];
      list.push(row);
      map.set(row.supplierId, list);
    }
    return map;
  }

  private async lastPurchases(tenantId: string, supplierIds: string[]) {
    const map = new Map<string, string>();
    if (supplierIds.length === 0) return map;
    const rows = await this.db
      .select({ supplierId: stockMovements.supplierId, at: sql<string>`max(${stockMovements.occurredAt})::text` })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, tenantId), inArray(stockMovements.supplierId, supplierIds)))
      .groupBy(stockMovements.supplierId);
    for (const row of rows) if (row.supplierId) map.set(row.supplierId, new Date(row.at).toISOString());
    return map;
  }

  private async requireSupplier(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string, lock = false) {
    const query = executor
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, businessId), eq(suppliers.id, id)))
      .limit(1);
    const [supplier] = lock ? await query.for("update") : await query;
    if (!supplier) throw new ApiError("SUPPLIER_NOT_FOUND", "That supplier was not found.", 404);
    return supplier;
  }

  private async existingEntry(tenant: TenantContext, id: string) {
    const [row] = await this.db.select({ tenantId: supplierEntries.tenantId }).from(supplierEntries).where(eq(supplierEntries.id, id)).limit(1);
    if (row && row.tenantId !== tenant.tenantId) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    return Boolean(row);
  }

  private phone(text: string | undefined, business: Business) {
    if (!text?.trim()) return null;
    const result = checkPhone(text, business.countryCode.trim());
    if (!result?.ok) {
      const message = result ? phoneProblemMessage(result.problem, result.country) : "Enter a valid phone number.";
      throw new ApiError("VALIDATION_ERROR", message, 400, [{ field: "phone", message }]);
    }
    return result.e164;
  }

  private paidFromAccount(paidFrom: SupplierPaidFrom, branchId: string): AccountRef {
    if (paidFrom === "cash") return { role: "cash", branchId };
    if (paidFrom === "bank") return { role: "bank" };
    return { role: "capital" };
  }

  private pastDay(value: string | undefined, business: Business) {
    const today = localDate(new Date(), business.timezone);
    if (!value) return today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError("VALIDATION_ERROR", "Use a date like 2026-11-18.", 400);
    if (value > today) throw new ApiError("VALIDATION_ERROR", "That day has not come yet.", 400, [{ field: "paymentDate", message: "In the future." }]);
    if (daysBetween(value, today) > 366) throw new ApiError("VALIDATION_ERROR", "That is more than a year ago.", 400, [{ field: "paymentDate", message: "Too long ago." }]);
    return value;
  }

  private view(row: Supplier) {
    return {
      id: row.id,
      name: row.name,
      phoneE164: row.phoneE164,
      notes: row.notes,
      unnamed: row.unnamed,
      archived: row.archivedAt !== null,
    };
  }

  private async record(
    executor: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    branchId: string | null,
    action: string,
    supplierId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "supplier",
        entityId: supplierId,
        correlationId: tenant.correlationId,
        businessId,
        ...(branchId ? { branchId } : {}),
        actorType: tenant.actorType ?? "HUMAN",
        metadata,
      },
      executor,
    );
  }
}
