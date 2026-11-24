import { nameKey } from "@bizora/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { brands, catalogItems, categories, priceListPrices, priceLists, supplierProducts } from "../../db/schema.js";
import { findOrAddSupplier } from "../suppliers/supplier-ledger.js";

/** Category levels a product file may name: "Drinks > Soft drinks > Cans". */
export const CATEGORY_PATH_MAX = 3;

/** "Drinks > Soft drinks", "Drinks / Soft drinks" or "Drinks › Soft drinks" into its levels, top first. */
export function categoryLevels(text: string) {
  return text
    .split(/\s*[>/›]\s*/)
    .map((level) => level.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * Finds a category by its path from the top, making the levels that are missing (ADR-065). The same words find the
 * same category however they are spaced or capitalised.
 */
export async function categoryFromPath(executor: DbExecutor, tenant: TenantContext, businessId: string, text: string) {
  let parentId: string | null = null;
  for (const level of categoryLevels(text).slice(0, CATEGORY_PATH_MAX)) {
    const key = nameKey(level).slice(0, 60);
    const where = and(
      eq(categories.tenantId, tenant.tenantId),
      eq(categories.businessId, businessId),
      parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId),
      eq(categories.nameKey, key),
    );
    let [found] = await executor.select({ id: categories.id }).from(categories).where(where).limit(1);
    if (!found) {
      await executor
        .insert(categories)
        .values({ id: newId(), tenantId: tenant.tenantId, businessId, parentId, name: level.slice(0, 60), nameKey: key, createdBy: tenant.userId, updatedBy: tenant.userId })
        .onConflictDoNothing();
      [found] = await executor.select({ id: categories.id }).from(categories).where(where).limit(1);
    }
    parentId = found?.id ?? null;
  }
  return parentId;
}

/** A brand by name, added when it is new. */
export async function brandFromName(executor: DbExecutor, tenant: TenantContext, businessId: string, name: string) {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
  const key = nameKey(clean);
  const where = and(eq(brands.tenantId, tenant.tenantId), eq(brands.businessId, businessId), eq(brands.nameKey, key));
  const [found] = await executor.select({ id: brands.id }).from(brands).where(where).limit(1);
  if (found) return found.id;
  await executor.insert(brands).values({ id: newId(), tenantId: tenant.tenantId, businessId, name: clean, nameKey: key, createdBy: tenant.userId, updatedBy: tenant.userId }).onConflictDoNothing();
  const [made] = await executor.select({ id: brands.id }).from(brands).where(where).limit(1);
  return made?.id ?? null;
}

/** An item in use with this name, for adding a variant row to it. */
export async function itemByName(executor: DbExecutor, tenantId: string, businessId: string, name: string) {
  const [item] = await executor
    .select({ id: catalogItems.id, name: catalogItems.name })
    .from(catalogItems)
    .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.businessId, businessId), isNull(catalogItems.archivedAt), sql`lower(${catalogItems.name}) = ${nameKey(name)}`))
    .limit(1);
  return item ?? null;
}

/** The supplier's own code for a product, adding the supplier when new. */
export async function setSupplierCode(executor: DbExecutor, tenant: TenantContext, business: { id: string; baseCurrencyCode: string }, productId: string, supplierName: string, code: string) {
  const supplier = await findOrAddSupplier(executor, tenant, business.id, { name: supplierName.trim() });
  if (!supplier) return;
  const values = { ...(code.trim() ? { supplierSku: code.trim().slice(0, 64) } : {}), updatedAt: new Date(), updatedBy: tenant.userId };
  await executor
    .insert(supplierProducts)
    .values({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, supplierId: supplier.id, productId, currencyCode: business.baseCurrencyCode.trim(), ...values })
    .onConflictDoUpdate({ target: [supplierProducts.tenantId, supplierProducts.supplierId, supplierProducts.productId], set: values });
}

/** A product's price on a price list, for one of the base unit (no quantity break, no dates). */
export async function setListPrice(executor: DbExecutor, tenant: TenantContext, businessId: string, listId: string, productId: string, unitCode: string, priceMinor: bigint) {
  const where = and(
    eq(priceListPrices.tenantId, tenant.tenantId),
    eq(priceListPrices.priceListId, listId),
    eq(priceListPrices.productId, productId),
    eq(priceListPrices.unitCode, unitCode),
    eq(priceListPrices.minQuantity, 1000n),
    isNull(priceListPrices.effectiveFrom),
  );
  const [existing] = await executor.select({ id: priceListPrices.id }).from(priceListPrices).where(where).limit(1);
  if (existing) {
    await executor.update(priceListPrices).set({ priceMinor, updatedAt: new Date(), updatedBy: tenant.userId }).where(eq(priceListPrices.id, existing.id));
  } else {
    await executor.insert(priceListPrices).values({ id: newId(), tenantId: tenant.tenantId, businessId, priceListId: listId, productId, unitCode, minQuantity: 1000n, priceMinor, updatedBy: tenant.userId });
  }
}

/** The business's price lists by name, for reading a product file. */
export async function priceListsByName(executor: DbExecutor, tenantId: string, businessId: string) {
  const rows = await executor
    .select({ id: priceLists.id, name: priceLists.name, nameKey: priceLists.nameKey })
    .from(priceLists)
    .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.businessId, businessId), eq(priceLists.active, true)));
  return new Map(rows.map((row) => [row.nameKey, row]));
}

/** "yes", "no" or empty, as a product file says it. */
export function yesNo(text: string): boolean | null | "bad" {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  if (["yes", "y", "true", "1"].includes(value)) return true;
  if (["no", "n", "false", "0"].includes(value)) return false;
  return "bad";
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];

/** A CSV cell: quoted when it holds a comma, quote or line break; a leading = + - @ is kept as text. */
function cell(value: string | null | undefined) {
  const text = value ?? "";
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Minor units as the amount a person types: 450000 kobo → 4500, 450050 → 4500.50. */
function amount(minor: string | null, digits: number) {
  if (minor === null) return "";
  const value = BigInt(minor);
  if (digits === 0) return value.toString();
  const scale = 10n ** BigInt(digits);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = absolute % scale;
  const text = fraction === 0n ? (absolute / scale).toString() : `${absolute / scale}.${fraction.toString().padStart(digits, "0")}`;
  return negative ? `-${text}` : text;
}

/** Thousandths as typed: 1500 → 1.5. */
function quantity(thousandths: string | null) {
  if (thousandths === null) return "";
  const value = BigInt(thousandths);
  const whole = value / 1000n;
  const fraction = (value < 0n ? -value : value) % 1000n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

export const PRODUCT_FILE_HEADERS = [
  "Name",
  "Item group",
  "Variant",
  "SKU",
  "GTIN",
  "Barcode",
  "Brand",
  "Category",
  "Unit",
  "Price",
  "Cost",
  "Quantity",
  "Low stock",
  "Pack unit",
  "Pack size",
  "Pack price",
  "Pack sold",
  "Pack bought",
  "Supplier",
  "Supplier code",
  "Price list",
  "Price list price",
] as const;

/**
 * The business's products as a CSV file with the same columns the product import reads (ADR-065), so a file can be
 * exported, changed in a spreadsheet and read back in. One row per product; its first pack, its usual supplier and
 * its first price list price. Stock is this shop's. Cost only for people who may see it.
 */
export async function productsCsv(
  executor: DbExecutor,
  tenant: TenantContext,
  business: { id: string; baseCurrencyCode: string },
  branchId: string,
  digits: number,
  seeCost: boolean,
) {
  const rows = rowsOf<{
    name: string;
    item_name: string | null;
    variant_label: string | null;
    sku: string | null;
    gtin: string | null;
    barcode: string | null;
    brand: string | null;
    category_id: string | null;
    category: string | null;
    base_unit: string;
    price_minor: string | null;
    cost_minor: string | null;
    quantity: string | null;
    low_stock_level: string | null;
    track_stock: boolean;
    pack_unit: string | null;
    pack_size: string | null;
    pack_price: string | null;
    pack_for_sale: boolean | null;
    pack_for_purchase: boolean | null;
    supplier: string | null;
    supplier_code: string | null;
    price_list: string | null;
    price_list_price: string | null;
  }>(
    await executor.execute(sql`
      SELECT p.name, ci.name AS item_name, p.variant_label, p.sku, p.gtin, p.barcode, b.name AS brand, ci.category_id, p.category,
        p.base_unit, p.price_minor::text AS price_minor, p.default_cost_minor::text AS cost_minor, sb.quantity::text AS quantity,
        p.low_stock_level::text AS low_stock_level, p.track_stock,
        pack.unit_code AS pack_unit, pack.base_quantity::text AS pack_size, pack.price_minor::text AS pack_price, pack.for_sale AS pack_for_sale, pack.for_purchase AS pack_for_purchase,
        sup.name AS supplier, sup.supplier_sku AS supplier_code, lp.name AS price_list, lp.price_minor::text AS price_list_price
      FROM products p
      LEFT JOIN catalog_items ci ON ci.tenant_id = p.tenant_id AND ci.id = p.catalog_item_id
      LEFT JOIN brands b ON b.tenant_id = ci.tenant_id AND b.id = ci.brand_id
      LEFT JOIN stock_balances sb ON sb.tenant_id = p.tenant_id AND sb.product_id = p.id AND sb.branch_id = ${branchId}
      LEFT JOIN LATERAL (
        SELECT u.unit_code, u.base_quantity, u.price_minor, u.for_sale, u.for_purchase FROM product_units u
        WHERE u.tenant_id = p.tenant_id AND u.product_id = p.id ORDER BY u.base_quantity LIMIT 1
      ) pack ON true
      LEFT JOIN LATERAL (
        SELECT s.name, sp.supplier_sku FROM supplier_products sp JOIN suppliers s ON s.tenant_id = sp.tenant_id AND s.id = sp.supplier_id AND NOT s.unnamed
        WHERE sp.tenant_id = p.tenant_id AND sp.product_id = p.id ORDER BY sp.preferred DESC, sp.last_received_at DESC NULLS LAST LIMIT 1
      ) sup ON true
      LEFT JOIN LATERAL (
        SELECT l.name, pp.price_minor FROM price_list_prices pp JOIN price_lists l ON l.tenant_id = pp.tenant_id AND l.id = pp.price_list_id AND l.active
        WHERE pp.tenant_id = p.tenant_id AND pp.product_id = p.id AND pp.unit_code = p.base_unit AND pp.min_quantity = 1000 AND pp.effective_from IS NULL
        ORDER BY l.position, l.name LIMIT 1
      ) lp ON true
      WHERE p.tenant_id = ${tenant.tenantId} AND p.business_id = ${business.id} AND p.archived_at IS NULL
      ORDER BY coalesce(ci.name, p.name), p.variant_label NULLS FIRST, p.name`),
  );
  // Category paths, worked out once from the business's categories.
  const levels = rowsOf<{ id: string; name: string; parent_id: string | null }>(
    await executor.execute(sql`SELECT id, name, parent_id FROM categories WHERE tenant_id = ${tenant.tenantId} AND business_id = ${business.id}`),
  );
  const byId = new Map(levels.map((level) => [level.id, level]));
  const pathOf = (id: string | null) => {
    const names: string[] = [];
    let current = id ? byId.get(id) : undefined;
    for (let depth = 0; current && depth < 8; depth += 1) {
      names.unshift(current.name);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return names.join(" > ");
  };
  const yes = (value: boolean | null) => (value === null ? "" : value ? "yes" : "no");
  const lines = [PRODUCT_FILE_HEADERS.filter((header) => seeCost || header !== "Cost").map(cell).join(",")];
  for (const row of rows) {
    const values = [
      row.name,
      row.variant_label ? row.item_name : "",
      row.variant_label ?? "",
      row.sku,
      row.gtin,
      row.barcode,
      row.brand,
      pathOf(row.category_id) || row.category,
      row.base_unit,
      amount(row.price_minor, digits),
      ...(seeCost ? [amount(row.cost_minor, digits)] : []),
      row.track_stock ? quantity(row.quantity ?? "0") : "",
      quantity(row.low_stock_level),
      row.pack_unit,
      quantity(row.pack_size),
      amount(row.pack_price, digits),
      row.pack_unit ? yes(row.pack_for_sale) : "",
      row.pack_unit ? yes(row.pack_for_purchase) : "",
      row.supplier,
      row.supplier_code,
      row.price_list,
      amount(row.price_list_price, digits),
    ];
    lines.push(values.map(cell).join(","));
  }
  return { rows: rows.length, csv: `\uFEFF${lines.join("\r\n")}\r\n` };
}
