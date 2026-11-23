import { sql } from "drizzle-orm";
import { newId } from "../../common/ids.js";
import type { DbExecutor } from "../../db/database.js";
import type { TenantContext } from "../../common/tenant-context.js";

const QUANTITY_SCALE = 1000n;

/** Per base unit, rounded half up, from a total for `baseQuantity` thousandths. */
const perUnit = (total: bigint, baseQuantity: bigint) => (baseQuantity > 0n ? (total * QUANTITY_SCALE * 2n + baseQuantity) / (baseQuantity * 2n) : 0n);

/**
 * Keeps what a product last cost to buy (ADR-048): on the product (the supplier's price and the landed cost with
 * charges) and on the supplier's line for the product, which is added the first time the supplier delivers it.
 * A delivery recorded later for an earlier day (an import, a photo of a book) does not replace a newer cost.
 */
export async function recordPurchaseCost(
  tx: DbExecutor,
  tenant: TenantContext,
  input: {
    businessId: string;
    productId: string;
    supplierId: string | null;
    goodsMinor: bigint;
    chargesMinor: bigint;
    baseQuantity: bigint;
    currencyCode: string;
    at: Date;
  },
) {
  if (input.baseQuantity <= 0n) return;
  const goods = perUnit(input.goodsMinor, input.baseQuantity);
  const landed = perUnit(input.goodsMinor + input.chargesMinor, input.baseQuantity);
  const at = input.at.toISOString();
  await tx.execute(sql`
    UPDATE products SET last_purchase_cost_minor = ${goods}, last_landed_cost_minor = ${landed}, last_purchased_at = ${at}::timestamptz
    WHERE tenant_id = ${tenant.tenantId} AND business_id = ${input.businessId} AND id = ${input.productId}
      AND (last_purchased_at IS NULL OR last_purchased_at <= ${at}::timestamptz)`);
  if (!input.supplierId) return;
  await tx.execute(sql`
    INSERT INTO supplier_products (id, tenant_id, business_id, supplier_id, product_id, last_cost_minor, currency_code, last_received_at, updated_by)
    VALUES (${newId()}, ${tenant.tenantId}, ${input.businessId}, ${input.supplierId}, ${input.productId}, ${goods}, ${input.currencyCode}, ${at}::timestamptz, ${tenant.userId})
    ON CONFLICT (tenant_id, supplier_id, product_id) DO UPDATE SET
      last_cost_minor = CASE WHEN supplier_products.last_received_at IS NULL OR supplier_products.last_received_at <= EXCLUDED.last_received_at THEN EXCLUDED.last_cost_minor ELSE supplier_products.last_cost_minor END,
      last_received_at = GREATEST(coalesce(supplier_products.last_received_at, EXCLUDED.last_received_at), EXCLUDED.last_received_at),
      updated_at = now()`);
}
