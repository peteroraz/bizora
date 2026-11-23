import { Permission } from "@bizora/contracts";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { rowsOf } from "./rows.js";

export type PriceListRef = { id: string; name: string };

/**
 * Which price list prices a sale (ADR-048): the one chosen at the counter, else the customer's. A list chosen at the
 * counter must be usable here (active, this shop or every shop, the business's currency) and, unless the owner let
 * staff choose it, needs someone who may give discounts. A customer's list that does not apply here is left out and
 * the everyday prices are used, so a sale is never refused for it.
 */
export async function choosePriceList(
  tx: DbExecutor,
  tenant: TenantContext,
  input: {
    businessId: string;
    branchId: string;
    currencyCode: string;
    chosenId?: string | undefined;
    customerListId?: string | null;
    /** A sale made here and now. One made offline or typed in from a book is kept: the list is used only if it still applies. */
    live?: boolean;
  },
): Promise<PriceListRef | null> {
  // A sale made offline or typed in was priced on the phone or in the book: only a list it names is used, so the
  // server prices what the person saw. Here and now, the customer's list applies on its own.
  const id = input.chosenId ?? (input.live === false ? null : (input.customerListId ?? null));
  if (!id) return null;
  const rows = rowsOf<{ id: string; name: string; active: boolean; branch_id: string | null; currency_code: string; staff_can_choose: boolean }>(
    await tx.execute(sql`
      SELECT id, name, active, branch_id, currency_code, staff_can_choose FROM price_lists
      WHERE tenant_id = ${tenant.tenantId} AND business_id = ${input.businessId} AND id = ${id}`),
  );
  const list = rows[0];
  const usable = list && list.active && (list.branch_id === null || list.branch_id === input.branchId) && list.currency_code.trim() === input.currencyCode.trim();
  if (!input.chosenId || input.live === false) return usable ? { id: list.id, name: list.name } : null;
  if (!list) throw new ApiError("PRICE_LIST_NOT_FOUND", "That price list was not found.", 404, [{ field: "priceListId", message: "Not found." }]);
  if (!usable) throw new ApiError("PRICE_LIST_NOT_HERE", `The ${list.name} prices are not used in this shop.`, 409, [{ field: "priceListId", message: "Not used here." }]);
  if (!list.staff_can_choose && !tenant.permissions.includes(Permission.SALES_DISCOUNT)) {
    throw new ApiError("FORBIDDEN", `Ask a manager to sell at the ${list.name} prices.`, 403, [{ field: "priceListId", message: "Ask a manager." }]);
  }
  return { id: list.id, name: list.name };
}

/**
 * The list's prices for these products on a day, keyed by product and unit. Each entry holds the price tiers that
 * apply that day, largest minimum quantity first; for one date range per tier, the latest start wins.
 */
export async function listPrices(tx: DbExecutor, tenantId: string, priceListId: string, productIds: string[], day: string) {
  const prices = new Map<string, { minQuantity: bigint; priceMinor: bigint }[]>();
  if (productIds.length === 0) return prices;
  const rows = rowsOf<{ product_id: string; unit_code: string; min_quantity: string; price_minor: string }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (product_id, unit_code, min_quantity) product_id, unit_code, min_quantity::text, price_minor::text
      FROM price_list_prices
      WHERE tenant_id = ${tenantId} AND price_list_id = ${priceListId}
        AND product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
        AND (effective_from IS NULL OR effective_from <= ${day}::date)
        AND (effective_to IS NULL OR effective_to >= ${day}::date)
      ORDER BY product_id, unit_code, min_quantity DESC, effective_from DESC NULLS LAST`),
  );
  for (const row of rows) {
    const key = `${row.product_id}:${row.unit_code}`;
    const tiers = prices.get(key) ?? [];
    tiers.push({ minQuantity: BigInt(row.min_quantity), priceMinor: BigInt(row.price_minor) });
    prices.set(key, tiers);
  }
  for (const tiers of prices.values()) tiers.sort((a, b) => (b.minQuantity > a.minQuantity ? 1 : b.minQuantity < a.minQuantity ? -1 : 0));
  return prices;
}

/** The list price for `entered` thousandths of a unit: the tier with the largest minimum it reaches. */
export function tierPrice(tiers: { minQuantity: bigint; priceMinor: bigint }[] | undefined, entered: bigint): bigint | null {
  return tiers?.find((tier) => entered >= tier.minQuantity)?.priceMinor ?? null;
}
