/**
 * Weighted-average stock cost per product per shop (ADR-013).
 *
 * Quantities are whole numbers of thousandths of a unit (QUANTITY_SCALE), so 0.5 kg is 500n and 3 cartons are 3000n.
 * Values are bigint minor units (kobo). Issuing stock removes value in proportion to quantity, rounded half up,
 * and the last unit out takes whatever value is left, so the stock value never drifts from the ledger.
 */
export const QUANTITY_SCALE = 1000n;

export type StockPosition = { readonly quantity: bigint; readonly valueMinor: bigint };

export class StockCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockCostError";
  }
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new StockCostError("Denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const result = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -result : result;
}

export function emptyPosition(): StockPosition {
  return { quantity: 0n, valueMinor: 0n };
}

/** Goods received at a total cost. */
export function receiveStock(position: StockPosition, quantity: bigint, totalCostMinor: bigint): StockPosition {
  if (quantity <= 0n) throw new StockCostError("Quantity received must be positive");
  if (totalCostMinor < 0n) throw new StockCostError("Cost cannot be negative");
  return { quantity: position.quantity + quantity, valueMinor: position.valueMinor + totalCostMinor };
}

/** Average cost of one whole unit, in minor units, rounded half up. */
export function averageUnitCost(position: StockPosition): bigint | null {
  if (position.quantity <= 0n) return null;
  return divideHalfUp(position.valueMinor * QUANTITY_SCALE, position.quantity);
}

/**
 * Goods leaving (sold, lost, transferred out). Returns their cost and the new position.
 * Selling more than is on hand is allowed (negative stock is flagged for review, ADR-012); the extra quantity
 * is costed at the last average unit cost, or `fallbackUnitCostMinor` when there was none.
 */
export function issueStock(
  position: StockPosition,
  quantity: bigint,
  fallbackUnitCostMinor = 0n,
): { costMinor: bigint; position: StockPosition; negative: boolean } {
  if (quantity <= 0n) throw new StockCostError("Quantity issued must be positive");
  const onHand = position.quantity > 0n ? position.quantity : 0n;
  const fromStock = quantity < onHand ? quantity : onHand;
  let costMinor =
    fromStock === 0n ? 0n : fromStock === onHand ? position.valueMinor : divideHalfUp(position.valueMinor * fromStock, onHand);
  const extra = quantity - fromStock;
  if (extra > 0n) {
    const unitCost = averageUnitCost(position) ?? fallbackUnitCostMinor;
    costMinor += divideHalfUp(unitCost * extra, QUANTITY_SCALE);
  }
  const next = { quantity: position.quantity - quantity, valueMinor: position.valueMinor - costMinor };
  return { costMinor, position: next, negative: next.quantity < 0n };
}
