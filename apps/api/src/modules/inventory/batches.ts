import { quantityToString } from "@bizora/contracts";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { DbExecutor } from "../../db/database.js";

/**
 * Batches and expiry (ADR-061). For a product that tracks batches, every movement also moves batch quantities:
 * stock coming in goes into its batch (the same batch number and expiry adds to the batch already here); stock going
 * out comes from the earliest expiry first (first-expiry-first-out), and the movement remembers which batches. A batch
 * with no number and no expiry holds stock that has none (bought before tracking began, or brought back).
 *
 * Batches hold quantities only. The value of stock stays the weighted average of ADR-014, so the books do not change.
 */
export type BatchIn = { batchNumber?: string | null; expiryDate?: string | null; manufacturedDate?: string | null; supplierId?: string | null };
export type BatchUse = { batchId: string; batchNumber: string | null; expiryDate: string | null; quantity: bigint };

type Scope = { tenantId: string; businessId: string; branchId: string; productId: string; productName: string };

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];

/** Adds stock to its batch, making the batch the first time. */
export async function addToBatch(tx: DbExecutor, scope: Scope, movementId: string, quantity: bigint, batch: BatchIn, at: Date): Promise<BatchUse[]> {
  if (quantity <= 0n) return [];
  const number = batch.batchNumber?.trim() || null;
  const expiry = batch.expiryDate || null;
  const id = newId();
  const [row] = rowsOf<{ id: string; batch_number: string | null; expiry_date: string | null }>(
    await tx.execute(sql`
      INSERT INTO stock_batches (id, tenant_id, business_id, branch_id, product_id, batch_number, expiry_date, manufactured_date, supplier_id, quantity, received_quantity, first_received_at)
      VALUES (${id}, ${scope.tenantId}, ${scope.businessId}, ${scope.branchId}, ${scope.productId}, ${number}, ${expiry}::date, ${batch.manufacturedDate || null}::date, ${batch.supplierId ?? null}, ${quantity}, ${quantity}, ${at.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, branch_id, product_id, coalesce(batch_number, ''), coalesce(expiry_date, '1900-01-01'::date))
      DO UPDATE SET quantity = stock_batches.quantity + EXCLUDED.quantity,
        received_quantity = stock_batches.received_quantity + EXCLUDED.received_quantity,
        manufactured_date = coalesce(stock_batches.manufactured_date, EXCLUDED.manufactured_date),
        updated_at = now()
      RETURNING id, batch_number, expiry_date::text AS expiry_date`),
  );
  if (!row) return [];
  await record(tx, scope, movementId, row.id, quantity);
  return [{ batchId: row.id, batchNumber: row.batch_number, expiryDate: row.expiry_date, quantity }];
}

/**
 * Takes stock out of batches: one named batch, or the earliest expiry first. A sale made here and now is refused
 * when only expired stock would be left to sell, saying how much is past its date; a sale that already happened
 * (offline, typed in from a book) is kept as it was. Anything more than the batches hold (stock
 * from before tracking began) comes from no batch and is not recorded against one.
 */
export async function takeFromBatches(
  tx: DbExecutor,
  scope: Scope,
  movementId: string,
  quantity: bigint,
  options: { batchId?: string | null; today: string; onHand: bigint; preferFresh?: boolean; refuseExpired?: boolean },
): Promise<BatchUse[]> {
  if (quantity <= 0n) return [];
  const batches = rowsOf<{ id: string; batch_number: string | null; expiry_date: string | null; quantity: string }>(
    await tx.execute(sql`
      SELECT id, batch_number, expiry_date::text AS expiry_date, quantity::text AS quantity FROM stock_batches
      WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND product_id = ${scope.productId} AND quantity > 0
        ${options.batchId ? sql`AND id = ${options.batchId}` : sql``}
      ORDER BY expiry_date ASC NULLS LAST, first_received_at ASC
      FOR UPDATE`),
  );
  if (options.batchId && batches.length === 0) throw new ApiError("BATCH_NOT_FOUND", "That batch has nothing left here.", 404, [{ field: "batchId", message: "Nothing left." }]);
  const fresh = batches.filter((batch) => !batch.expiry_date || batch.expiry_date >= options.today);
  if (options.refuseExpired && !options.batchId) {
    // Stock from before batches were kept is in no batch; it counts as within date.
    const inBatches = batches.reduce((sum, batch) => sum + BigInt(batch.quantity), 0n);
    const outside = options.onHand > inBatches ? options.onHand - inBatches : 0n;
    const freshQuantity = fresh.reduce((sum, batch) => sum + BigInt(batch.quantity), 0n) + outside;
    const expiredQuantity = inBatches + outside - freshQuantity;
    if (freshQuantity < quantity && expiredQuantity > 0n) {
      throw new ApiError(
        "EXPIRED_STOCK",
        `Only ${quantityToString(freshQuantity)} of ${scope.productName} here is within its expiry date; ${quantityToString(expiredQuantity)} is past it. Remove the expired stock first.`,
        422,
        [{ field: "quantity", message: "Only expired stock is left." }],
      );
    }
  }
  // Sales and job use take what is within date first; anything else (removing expired stock, counts, transfers)
  // simply takes the earliest expiry first.
  const order = options.preferFresh && !options.batchId ? [...fresh, ...batches.filter((batch) => !fresh.includes(batch))] : batches;
  const used: BatchUse[] = [];
  let left = quantity;
  for (const batch of order) {
    if (left === 0n) break;
    const take = BigInt(batch.quantity) < left ? BigInt(batch.quantity) : left;
    await tx.execute(sql`UPDATE stock_batches SET quantity = quantity - ${take}, updated_at = now() WHERE tenant_id = ${scope.tenantId} AND id = ${batch.id}`);
    await record(tx, scope, movementId, batch.id, -take);
    used.push({ batchId: batch.id, batchNumber: batch.batch_number, expiryDate: batch.expiry_date, quantity: take });
    left -= take;
  }
  if (options.batchId && left > 0n) {
    throw new ApiError("NOT_ENOUGH_IN_BATCH", `That batch has only ${quantityToString(quantity - left)} left.`, 422, [{ field: "quantity", message: "More than the batch holds." }]);
  }
  return used;
}

/** The batches a movement took from, to carry them to another shop (a transfer arriving). */
export async function batchesOfMovement(tx: DbExecutor, tenantId: string, movementId: string) {
  return rowsOf<{ batch_number: string | null; expiry_date: string | null; manufactured_date: string | null; quantity: string }>(
    await tx.execute(sql`
      SELECT b.batch_number, b.expiry_date::text AS expiry_date, b.manufactured_date::text AS manufactured_date, (-mb.quantity)::text AS quantity
      FROM stock_movement_batches mb JOIN stock_batches b ON b.tenant_id = mb.tenant_id AND b.id = mb.batch_id
      WHERE mb.tenant_id = ${tenantId} AND mb.movement_id = ${movementId} AND mb.quantity < 0
      ORDER BY b.expiry_date ASC NULLS LAST`),
  ).map((row) => ({ batchNumber: row.batch_number, expiryDate: row.expiry_date, manufacturedDate: row.manufactured_date, quantity: BigInt(row.quantity) }));
}

async function record(tx: DbExecutor, scope: Scope, movementId: string, batchId: string, quantity: bigint) {
  await tx.execute(sql`
    INSERT INTO stock_movement_batches (id, tenant_id, business_id, movement_id, batch_id, quantity)
    VALUES (${newId()}, ${scope.tenantId}, ${scope.businessId}, ${movementId}, ${batchId}, ${quantity})`);
}
