import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { PAID_FROM, STOCK_ADD_REASONS, STOCK_REMOVE_REASONS, UNIT_CODES, parseCountQuantity, parseQuantity } from "./stock-units.js";

export * from "./stock-units.js";

export const unitCodeSchema = z.enum(UNIT_CODES);

const decimalQuantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const countQuantity = z.string().trim().refine((value) => parseCountQuantity(value) !== null, "Enter how many you counted.");
const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const clientId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");
const note = z.string().trim().max(240).optional();

export const packUnitInputSchema = z.object({
  unitCode: unitCodeSchema,
  /** How many base units are in one of this pack, e.g. "24". */
  baseQuantity: decimalQuantity,
  priceMinor: minorAmount.optional(),
});

export const productWriteSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(60).optional().nullable(),
  baseUnit: unitCodeSchema,
  priceMinor: minorAmount.optional().nullable(),
  defaultCostMinor: minorAmount.optional().nullable(),
  lowStockLevel: z.union([decimalQuantity, z.literal("0")]).optional().nullable(),
  barcode: z.string().trim().max(64).optional().nullable(),
  trackStock: z.boolean().optional(),
  packs: z.array(packUnitInputSchema).max(5).optional(),
});

export const productCreateSchema = productWriteSchema.extend({
  id: clientId.optional(),
  /** Stock on hand today, counted in the base unit. Posted as opening stock against the owner's money. */
  openingQuantity: decimalQuantity.optional(),
  openingCostMinor: minorAmount.optional(),
});

export const stockReceiveSchema = z.object({
  id: clientId.optional(),
  productId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  quantity: decimalQuantity,
  unit: unitCodeSchema,
  /** Total cost of what was received. Left out when unknown; the current average or default cost is used. */
  totalCostMinor: minorAmount.optional(),
  paidFrom: z.enum(PAID_FROM).default("credit"),
  supplier: z.string().trim().max(160).optional(),
  note,
});

export const stockAdjustSchema = z
  .object({
    productId: z.string().uuid(),
    branchId: z.string().uuid().optional(),
    direction: z.enum(["remove", "add"]),
    reason: z.enum([...STOCK_REMOVE_REASONS, ...STOCK_ADD_REASONS]),
    quantity: decimalQuantity,
    unit: unitCodeSchema,
    note,
  })
  .refine(
    (value) =>
      value.direction === "remove"
        ? (STOCK_REMOVE_REASONS as readonly string[]).includes(value.reason)
        : (STOCK_ADD_REASONS as readonly string[]).includes(value.reason),
    { message: "Choose a reason that matches removing or adding stock.", path: ["reason"] },
  );

export const stockTransferSchema = z.object({
  productId: z.string().uuid(),
  fromBranchId: z.string().uuid().optional(),
  toBranchId: z.string().uuid(),
  quantity: decimalQuantity,
  unit: unitCodeSchema,
  note,
});

export const stockCountSchema = z.object({
  id: clientId.optional(),
  productId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  countedQuantity: countQuantity,
  unit: unitCodeSchema,
  note,
});

