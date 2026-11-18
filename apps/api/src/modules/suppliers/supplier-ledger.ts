import { UNNAMED_SUPPLIER } from "@bizora/contracts";
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { supplierEntries, suppliers } from "../../db/schema.js";

/**
 * Suppliers from stock in (ADR-029), shared by stock in and the supplier screens without a module cycle. Runs in
 * the caller's transaction, so a delivery and what it adds to a supplier's account save together.
 */

export type SupplierRef = { id: string; name: string; unnamed: boolean };

/**
 * The supplier for stock coming in: the one chosen by ID, or the one with this name (any capitals), added when it
 * is new. With neither, and `unnamedWhenMissing`, the business's "Supplier not named", so credit is never lost.
 */
export async function findOrAddSupplier(
  tx: DbExecutor,
  tenant: TenantContext,
  businessId: string,
  given: { supplierId?: string | undefined; name?: string | null | undefined; unnamedWhenMissing?: boolean },
): Promise<SupplierRef | null> {
  if (given.supplierId) {
    const [found] = await tx
      .select({ id: suppliers.id, name: suppliers.name, unnamed: suppliers.unnamed })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, businessId), eq(suppliers.id, given.supplierId)))
      .limit(1);
    if (!found) throw new ApiError("SUPPLIER_NOT_FOUND", "That supplier was not found.", 404, [{ field: "supplierId", message: "Not found." }]);
    return found;
  }
  const name = (given.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length >= 2) {
    const byName = () =>
      tx
        .select({ id: suppliers.id, name: suppliers.name, unnamed: suppliers.unnamed })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, businessId), sql`lower(${suppliers.name}) = lower(${name})`))
        .limit(1);
    const [existing] = await byName();
    if (existing) return existing;
    await tx
      .insert(suppliers)
      .values({ id: newId(), tenantId: tenant.tenantId, businessId, name: name.slice(0, 160), createdBy: tenant.userId })
      .onConflictDoNothing();
    const [added] = await byName();
    return added ?? null;
  }
  if (!given.unnamedWhenMissing) return null;
  const unnamed = () =>
    tx
      .select({ id: suppliers.id, name: suppliers.name, unnamed: suppliers.unnamed })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, businessId), eq(suppliers.unnamed, true)))
      .limit(1);
  const [existing] = await unnamed();
  if (existing) return existing;
  await tx
    .insert(suppliers)
    .values({ id: newId(), tenantId: tenant.tenantId, businessId, name: UNNAMED_SUPPLIER, unnamed: true, createdBy: tenant.userId })
    .onConflictDoNothing();
  const [added] = await unnamed();
  return added ?? null;
}

/** Stock received on credit: adds the cost to what the supplier is owed. The stock's own entry already credited it. */
export async function addPurchase(
  tx: DbExecutor,
  tenant: TenantContext,
  input: {
    businessId: string;
    branchId: string;
    supplierId: string;
    stockMovementId: string;
    amountMinor: bigint;
    currencyCode: string;
    entryDate: string;
    payBy?: string | undefined;
    journalEntryId: string | null;
  },
) {
  await tx
    .insert(supplierEntries)
    .values({
      id: newId(),
      tenantId: tenant.tenantId,
      businessId: input.businessId,
      supplierId: input.supplierId,
      branchId: input.branchId,
      kind: "purchase",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      entryDate: input.entryDate,
      payBy: input.payBy ?? null,
      stockMovementId: input.stockMovementId,
      journalEntryId: input.journalEntryId,
      createdBy: tenant.userId,
      membershipId: tenant.membershipId,
    })
    .onConflictDoNothing();
}

export type SupplierLine = { kind: string; amountMinor: bigint; entryDate: string; payBy: string | null };

const adds = (kind: string) => kind === "purchase" || kind === "opening";

/**
 * What is owed to a supplier and how much of it is late. Payments and goods sent back settle the oldest amounts
 * first, so the amounts still owed are the newest; one of those is late when its pay-by day has passed.
 */
export function owedOf(entries: SupplierLine[], today: string) {
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

/** What is owed to one supplier now, read inside the caller's transaction. */
export async function owedNow(tx: DbExecutor, tenantId: string, supplierId: string, today: string) {
  const rows = await tx
    .select({ kind: supplierEntries.kind, amountMinor: supplierEntries.amountMinor, entryDate: supplierEntries.entryDate, payBy: supplierEntries.payBy })
    .from(supplierEntries)
    .where(and(eq(supplierEntries.tenantId, tenantId), eq(supplierEntries.supplierId, supplierId), eq(supplierEntries.status, "recorded")));
  return owedOf(rows, today).owedMinor;
}

/** Goods sent back to a supplier and taken off what is owed to them (ADR-030). */
export async function addSupplierReturn(
  tx: DbExecutor,
  tenant: TenantContext,
  input: { businessId: string; branchId: string; supplierId: string; stockMovementId: string; amountMinor: bigint; currencyCode: string; entryDate: string; note?: string | null; journalEntryId: string | null },
) {
  await tx.insert(supplierEntries).values({
    id: newId(),
    tenantId: tenant.tenantId,
    businessId: input.businessId,
    supplierId: input.supplierId,
    branchId: input.branchId,
    kind: "return",
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    entryDate: input.entryDate,
    stockMovementId: input.stockMovementId,
    note: input.note ?? null,
    journalEntryId: input.journalEntryId,
    createdBy: tenant.userId,
    membershipId: tenant.membershipId,
  });
}
