import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { FLEXIBLE_UNIT, PAID_FROM, STOCK_ADD_REASONS, STOCK_REMOVE_REASONS, parseCountQuantity, parseQuantity } from "./stock-units.js";

export * from "./stock-units.js";

/** A standard unit or a short custom one such as cup or mudu (ADR-049). */
export const unitCodeSchema = z.string().trim().toLowerCase().regex(FLEXIBLE_UNIT, "Use a short unit such as piece, bag or cup.");

export const decimalQuantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const countQuantity = z.string().trim().refine((value) => parseCountQuantity(value) !== null, "Enter how many you counted.");
const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const clientId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");
const note = z.string().trim().max(240).optional();
const requiredNote = z.string().trim().min(3, "Say what happened, in a few words.").max(240);

export const packUnitInputSchema = z.object({
  unitCode: unitCodeSchema,
  /** How many base units are in one of this pack, e.g. "24". */
  baseQuantity: decimalQuantity,
  priceMinor: minorAmount.optional(),
  /** Whether stock is bought in, and sold in, this pack (ADR-046). Both by default. */
  forPurchase: z.boolean().optional(),
  forSale: z.boolean().optional(),
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
  /** Codes (ADR-046). A SKU is unique among the business's products in use; barcodes may repeat. */
  sku: z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, "Use letters, numbers, spaces and . _ - / only.").optional().nullable(),
  gtin: z.string().trim().max(14).optional().nullable(),
  mpn: z.string().trim().max(64).optional().nullable(),
  reference: z.string().trim().max(64).optional().nullable(),
  /** The item's category and brand (ADR-046). `category` (text) still works and finds or makes the category. */
  categoryId: z.string().uuid().optional().nullable(),
  brandId: z.string().uuid().optional().nullable(),
  /** Why the product was changed (7f). Needed when the selling price or cost changes; kept in its history. */
  changeReason: z.string().trim().max(240).optional(),
});

export const productCreateSchema = productWriteSchema.extend({
  id: clientId.optional(),
  /** Add this product as a variant of an existing item (ADR-046), named by `variantLabel`. */
  catalogItemId: z.string().uuid().optional(),
  variantLabel: z.string().trim().min(1).max(80).optional(),
  /** The item's type when a new item is made; only physical items keep stock. */
  itemType: z.enum(["physical", "service", "digital", "non_stock"]).optional(),
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
  /** When cash is paid at a warehouse, the shop whose drawer paid. A shop receiving its own stock can leave this out. */
  paidFromBranchId: z.string().uuid().optional(),
  supplier: z.string().trim().max(160).optional(),
  /** A supplier already on the list (ADR-029); otherwise the name in `supplier` is found or added. */
  supplierId: z.string().uuid().optional(),
  /** When stock bought on credit must be paid for. */
  payBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.").optional(),
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
    /** Taking stock off or adding it by hand always says what happened (7f). */
    note: requiredNote,
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


/** Approving a stock count may carry a note; rejecting one says why (7f). */
export const stockCountApproveSchema = z.object({ note }).strict();
export const stockCountRejectSchema = z.object({ note: requiredNote }).strict();

/** Why a product is removed from the list (7f). */
export const productArchiveSchema = z.object({ reason: note }).strict();

/** Product photos (ADR-033): up to 5 a product, shrunk on the phone to at most 1280 pixels a side. */
export const PRODUCT_PHOTO_MAX = 5;
export const PRODUCT_PHOTO_MAX_BYTES = 600 * 1024;
export const PRODUCT_PHOTO_MAX_SIDE = 1600;
export const PRODUCT_PHOTO_MIN_SIDE = 64;
export const productPhotoUploadSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png"]),
    dataBase64: z.string().min(16).max(Math.ceil(PRODUCT_PHOTO_MAX_BYTES / 3) * 4 + 4, "That photo is too large."),
  })
  .strict();
