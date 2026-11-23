import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { UNIT_CODES, parseQuantity } from "./stock-units.js";

/**
 * Catalog items and their variants (ADR-046). A product is a variant of a catalog item: it is what is stocked, sold,
 * counted and valued. A simple item has one variant, and the trader never sees the word.
 */
export const ITEM_TYPES = ["physical", "service", "digital", "non_stock"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
/** Only physical items keep stock. */
export const itemTracksStock = (type: ItemType) => type === "physical";

/** Categories nest at most this deep: "Food › Drinks › Soft drinks › Cans" and two more. */
export const CATEGORY_MAX_DEPTH = 6;

/** "  Golden   Penny " → "golden penny": how names are compared for duplicates. */
export function nameKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * GTIN-8, 12, 13 or 14 with a correct check digit. Barcodes stay free text (local and shop-made codes are fine), but
 * a GTIN field is checked so a typo does not end up in an online catalogue.
 */
export function isValidGtin(code: string) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop() as number;
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const decimalQuantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const clientId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
/** A business's own code: letters, digits and . _ - / and spaces inside. */
export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, "Use letters, numbers, spaces and . _ - / only.");
export const gtinSchema = z.string().trim().refine(isValidGtin, "This GTIN is not right: check the digits (8, 12, 13 or 14, with the last one as the check digit).");

export const categoryWriteSchema = z.object({
  name: z.string().trim().min(1, "Give the category a name.").max(60),
  parentId: z.string().uuid().optional().nullable(),
  position: z.number().int().min(0).max(100_000).optional(),
  active: z.boolean().optional(),
  taxonomyCode: optionalText(64),
});

export const brandWriteSchema = z.object({
  name: z.string().trim().min(1, "Give the brand a name.").max(80),
  manufacturer: optionalText(120),
  website: z.string().trim().url("Enter a full web address, starting with https://").max(200).optional().nullable(),
  logoUrl: z
    .string()
    .trim()
    .url()
    .max(400)
    .refine((value) => value.startsWith("https://"), "Use an https:// address.")
    .optional()
    .nullable(),
  active: z.boolean().optional(),
});

/** What belongs to the item, shared by its variants. Everything but the name is optional. */
export const catalogItemFields = {
  name: z.string().trim().min(1).max(160),
  itemType: z.enum(ITEM_TYPES).optional(),
  description: optionalText(2000),
  categoryId: z.string().uuid().optional().nullable(),
  brandId: z.string().uuid().optional().nullable(),
  taxable: z.boolean().optional(),
  taxCode: optionalText(32),
  pricesIncludeTax: z.boolean().optional(),
  durationMinutes: z.number().int().min(1).max(100_000).optional().nullable(),
  /** Commission on a service, in hundredths of a percent (250 = 2.5%). */
  commissionBasisPoints: z.number().int().min(0).max(10_000).optional().nullable(),
  onlineTitle: optionalText(160),
  shortDescription: optionalText(300),
  slug: z
    .string()
    .trim()
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use small letters, numbers and dashes, like peak-milk-400g.")
    .optional()
    .nullable(),
  seoTitle: optionalText(160),
  seoDescription: optionalText(300),
  onlineVisible: z.boolean().optional(),
  itemCondition: z.enum(["new", "used", "refurbished"]).optional().nullable(),
  weightGrams: z.string().trim().regex(/^\d{1,12}$/).optional().nullable(),
  lengthMm: z.number().int().min(0).max(100_000).optional().nullable(),
  widthMm: z.number().int().min(0).max(100_000).optional().nullable(),
  heightMm: z.number().int().min(0).max(100_000).optional().nullable(),
  taxonomyCode: optionalText(64),
};
export const catalogItemUpdateSchema = z.object(catalogItemFields).partial().extend({
  /** A changed name is copied to an item's only variant. */
  name: catalogItemFields.name.optional(),
});

export const variantPackSchema = z.object({
  unitCode: z.enum(UNIT_CODES),
  baseQuantity: decimalQuantity,
  priceMinor: minorAmount.optional(),
  forPurchase: z.boolean().optional(),
  forSale: z.boolean().optional(),
});

/** One variant: what is stocked and sold. A simple item sends one with no label. */
export const variantCreateSchema = z.object({
  id: clientId.optional(),
  variantLabel: z.string().trim().min(1).max(80).optional().nullable(),
  baseUnit: z.enum(UNIT_CODES),
  priceMinor: minorAmount.optional().nullable(),
  defaultCostMinor: minorAmount.optional().nullable(),
  lowStockLevel: z.union([decimalQuantity, z.literal("0")]).optional().nullable(),
  sku: skuSchema.optional().nullable(),
  barcode: z.string().trim().max(64).optional().nullable(),
  gtin: gtinSchema.optional().nullable(),
  mpn: optionalText(64),
  reference: optionalText(64),
  packs: z.array(variantPackSchema).max(5).optional(),
  openingQuantity: decimalQuantity.optional(),
  openingCostMinor: minorAmount.optional(),
});

/** Adding a variant to an item. The first extra one may also name the item's existing variant ("Small"). */
export const addVariantSchema = variantCreateSchema.extend({
  variantLabel: z.string().trim().min(1, "Give the variant a name, such as Black / Large.").max(80),
  firstLabel: z.string().trim().min(1).max(80).optional(),
});

export const catalogItemCreateSchema = z
  .object({
    id: clientId.optional(),
    ...catalogItemFields,
    variants: z.array(variantCreateSchema).min(1).max(100),
  })
  .refine((value) => value.variants.length === 1 || value.variants.every((variant) => variant.variantLabel), {
    message: "Give each variant a name, such as Black / Large.",
    path: ["variants"],
  })
  .refine((value) => new Set(value.variants.map((variant) => nameKey(variant.variantLabel ?? ""))).size === value.variants.length, {
    message: "Two variants have the same name.",
    path: ["variants"],
  });

export const catalogItemArchiveSchema = z.object({ reason: z.string().trim().max(240).optional() }).strict();

/** The full name of a variant, as it shows on receipts and stock lists: "Polo shirt Black / Large". */
export function variantName(itemName: string, variantLabel: string | null | undefined) {
  const label = variantLabel?.trim();
  return (label ? `${itemName.trim()} ${label}` : itemName.trim()).slice(0, 160);
}
