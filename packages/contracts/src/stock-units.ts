
/**
 * Products and stock helpers with no dependencies (ADR-014). Quantities travel as decimal strings ("2.5") and are stored as whole thousandths of
 * the product's base unit (2500), so no floating point is ever used. Money travels as strings of kobo ("150050").
 */
export const QUANTITY_DECIMALS = 3;
const SCALE = 1000n;

/** Units traders use. Labels live in the translation files (units.<code>). */
export const UNIT_CODES = [
  "piece",
  "pack",
  "carton",
  "bag",
  "sachet",
  "bottle",
  "can",
  "tin",
  "crate",
  "dozen",
  "bundle",
  "roll",
  "set",
  "pair",
  "paint",
  "kg",
  "g",
  "litre",
  "ml",
  "metre",
  "yard",
] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

/** "2.5" → 2500n (thousandths). Accepts up to 3 decimals; returns null for anything else, zero or negative. */
export function parseQuantity(text: string): bigint | null {
  const value = text.trim().replace(/,/g, "");
  const match = /^(\d{1,12})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(QUANTITY_DECIMALS, "0") || "0");
  const result = whole * SCALE + fraction;
  return result > 0n ? result : null;
}

/** Same as parseQuantity but allows zero (a stock count can be zero). */
export function parseCountQuantity(text: string): bigint | null {
  if (/^0+(\.0{1,3})?$/.test(text.trim())) return 0n;
  return parseQuantity(text);
}

/** 2500n → "2.5"; -1000n → "-1". */
export function quantityToString(quantity: bigint): string {
  const negative = quantity < 0n;
  const absolute = negative ? -quantity : quantity;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(QUANTITY_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Converts an amount of some unit into thousandths of the base unit. `unitBaseQuantity` is 1000 for the base unit. */
export function toBaseQuantity(enteredThousandths: bigint, unitBaseQuantity: bigint): bigint {
  const numerator = enteredThousandths * unitBaseQuantity;
  return (numerator + SCALE / 2n) / SCALE;
}

export type PackUnit = { unitCode: string; baseQuantity: bigint };

/**
 * Splits a quantity into packs, biggest first: 76 pieces with cartons of 24 → [{carton, 3}, {piece, 4}].
 * Only whole packs are used; whatever is left is shown in the base unit (with decimals if needed).
 */
export function splitIntoPacks(quantity: bigint, baseUnit: string, packs: PackUnit[]): { unitCode: string; quantity: bigint }[] {
  const negative = quantity < 0n;
  let remaining = negative ? -quantity : quantity;
  const parts: { unitCode: string; quantity: bigint }[] = [];
  for (const pack of [...packs].filter((item) => item.baseQuantity > SCALE).sort((a, b) => (b.baseQuantity > a.baseQuantity ? 1 : -1))) {
    const count = remaining / pack.baseQuantity;
    if (count > 0n) {
      parts.push({ unitCode: pack.unitCode, quantity: count * SCALE });
      remaining -= count * pack.baseQuantity;
    }
  }
  if (remaining > 0n || parts.length === 0) parts.push({ unitCode: baseUnit, quantity: remaining });
  return negative ? parts.map((part) => ({ ...part, quantity: -part.quantity })) : parts;
}

/** "1,500.50" or "1500.5" → 150050n kobo. Null when not a valid amount. */
export function parseMoneyInput(text: string): bigint | null {
  const value = text.trim().replace(/[,₦\s]/g, "").replace(/^N/i, "");
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

export const PAID_FROM = ["cash", "bank", "credit"] as const;
export const STOCK_REMOVE_REASONS = ["damaged", "expired", "missing", "own_use", "gift", "other"] as const;
export const STOCK_ADD_REASONS = ["found", "correction"] as const;
export { PRODUCT_PAGE_SIZE, PULL_PAGE_SIZE } from "./constants.js";
