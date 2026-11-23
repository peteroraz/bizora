import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { UNIT_CODES, parseQuantity } from "./stock-units.js";

/**
 * Price lists, suppliers per product and landed cost (ADR-048). Money is a string of minor units (kobo); quantities
 * are decimal strings stored as thousandths.
 */
const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const positiveAmount = minorAmount.refine((value) => BigInt(value) > 0n, "Enter an amount above zero.");
const quantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const clientId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");

export const priceListWriteSchema = z.object({
  name: z.string().trim().min(1, "Name the price list, such as Wholesale.").max(60),
  /** Only in this shop; left out, the list applies in every shop. */
  branchId: z.string().uuid().optional().nullable(),
  currencyCode: z.string().trim().length(3).toUpperCase().optional(),
  active: z.boolean().optional(),
  /** Staff without discount rights may choose it at the counter. */
  staffCanChoose: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export const priceListPriceSchema = z
  .object({
    productId: z.string().uuid(),
    /** The product's base unit or one of its packs. */
    unitCode: z.enum(UNIT_CODES),
    /** From how many of that unit this price applies. "1" by default. */
    minQuantity: quantity.optional(),
    priceMinor: minorAmount,
    effectiveFrom: day.optional().nullable(),
    effectiveTo: day.optional().nullable(),
  })
  .refine((value) => !value.effectiveFrom || !value.effectiveTo || value.effectiveTo >= value.effectiveFrom, { message: "The end date is before the start date.", path: ["effectiveTo"] });

export const priceListPricesSchema = z.object({ prices: z.array(priceListPriceSchema).min(1).max(500) });

/** Giving a customer a price list (or taking it away with null). */
export const customerPriceListSchema = z.object({ priceListId: z.string().uuid().nullable() }).strict();

export const supplierProductWriteSchema = z.object({
  productId: z.string().uuid(),
  supplierSku: z.string().trim().max(64).optional().nullable(),
  /** Per base unit of the product. */
  lastCostMinor: minorAmount.optional().nullable(),
  preferred: z.boolean().optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional().nullable(),
  minimumOrderQuantity: quantity.optional().nullable(),
  purchaseUnit: z.enum(UNIT_CODES).optional().nullable(),
});

/** What a delivery cost besides the goods. Paid in cash or from the bank; spread over the goods by their value. */
export const LANDED_COST_KINDS = ["transport", "clearing", "loading", "customs", "freight", "other"] as const;
export const landedChargeSchema = z.object({
  kind: z.enum(LANDED_COST_KINDS),
  amountMinor: positiveAmount,
  paidFrom: z.enum(["cash", "bank"]),
});

/** A delivery of several products, with charges spread over them by the goods' value. */
export const stockReceiptCreateSchema = z.object({
  id: clientId.optional(),
  branchId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  supplier: z.string().trim().max(160).optional(),
  /** How the goods were paid; the charges say their own. */
  paidFrom: z.enum(["cash", "bank", "credit"]).default("credit"),
  payBy: day.optional(),
  note: z.string().trim().max(240).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity,
        unit: z.enum(UNIT_CODES),
        /** What the goods on this line cost, before charges. */
        totalCostMinor: positiveAmount,
      }),
    )
    .min(1)
    .max(100),
  charges: z.array(landedChargeSchema).max(10).default([]),
});

/**
 * Spreads `total` over `weights` in proportion, in whole minor units, with the remainder going to the largest weights
 * first, so the parts always add up to the total exactly.
 */
export function spreadByWeight(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n || total === 0n) return weights.map(() => 0n);
  const parts = weights.map((weight) => (total * weight) / sum);
  let left = total - parts.reduce((acc, part) => acc + part, 0n);
  const order = weights.map((weight, index) => ({ weight, index, rest: (total * weight) % sum })).sort((a, b) => (b.rest === a.rest ? Number(b.weight - a.weight) : b.rest > a.rest ? 1 : -1));
  for (const { index } of order) {
    if (left === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts;
}
