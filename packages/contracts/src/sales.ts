import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { parseQuantity, UNIT_CODES } from "./stock-units.js";

export { SALE_PAGE_SIZE, IMPORT_MAX_ROWS } from "./constants.js";

/** Money a customer hands over now. Whatever is left unpaid is owed (credit) and needs a customer. */
export const PAYMENT_METHODS = ["cash", "transfer", "pos"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter an amount in kobo.");
const quantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");

export const saleLineInputSchema = z.object({
  productId: z.string().uuid(),
  quantity,
  unit: z.enum(UNIT_CODES),
  /** Price per unit sold. Left out: the product's price for that unit. Lower than that is a discount. */
  unitPriceMinor: minorAmount.optional(),
});

export const salePaymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: minorAmount,
  reference: z.string().trim().max(64).optional(),
});

export const saleCreateSchema = z.object({
  id: z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.").optional(),
  /** The number the device printed while offline, e.g. DEV3-000045. */
  provisionalNumber: z.string().trim().max(24).optional(),
  customerId: z.string().uuid().optional(),
  lines: z.array(saleLineInputSchema).min(1).max(100),
  payments: z.array(salePaymentInputSchema).max(3).default([]),
  /** Discount on the whole sale, in kobo. */
  discountMinor: minorAmount.optional(),
  note: z.string().trim().max(240).optional(),
  /** When the sale happened on the device (offline sales). The server accepts up to 7 days back. */
  soldAt: z.string().datetime({ offset: true }).optional(),
});
export type SaleCreateInput = z.infer<typeof saleCreateSchema>;

export const saleVoidSchema = z.object({ reason: z.string().trim().min(1).max(240) });

/** How imported sales are treated: counted fully (stock and accounts) or kept as history only. */
export const SALE_IMPORT_MODES = ["mixed", "full", "history"] as const;
export type SaleImportMode = (typeof SALE_IMPORT_MODES)[number];

const importCell = z.string().max(200).optional().default("");

export const productImportSchema = z.object({
  dryRun: z.boolean().default(true),
  rows: z
    .array(
      z.object({
        name: importCell,
        category: importCell,
        unit: importCell,
        price: importCell,
        cost: importCell,
        quantity: importCell,
        lowStock: importCell,
        barcode: importCell,
        packUnit: importCell,
        packSize: importCell,
        packPrice: importCell,
      }),
    )
    .min(1),
});

export const salesImportSchema = z.object({
  dryRun: z.boolean().default(true),
  /** mixed: today's sales count fully, older ones are history only. */
  mode: z.enum(SALE_IMPORT_MODES).default("mixed"),
  rows: z
    .array(
      z.object({
        date: importCell,
        product: importCell,
        quantity: importCell,
        unit: importCell,
        price: importCell,
        total: importCell,
        payment: importCell,
        customer: importCell,
        phone: importCell,
        ref: importCell,
      }),
    )
    .min(1),
});

export type ImportRowResult = {
  row: number;
  status: "create" | "update" | "skip" | "error";
  message?: string;
  errors?: { field: string; message: string }[];
  /** For sales: whether this row will change stock and the accounts. */
  counts?: boolean;
};

/** Reads how a sale was paid from words traders write. Empty means cash. "credit" means the customer owes it. */
export function paymentFromText(text: string): PaymentMethod | "credit" | null {
  const value = text.trim().toLowerCase();
  if (!value || ["cash", "csh"].includes(value)) return "cash";
  if (/^(transfer|trf|trans|bank|bank transfer|xfer|online)/.test(value)) return "transfer";
  if (/^(pos|card|atm|debit card)/.test(value)) return "pos";
  if (/^(credit|owe|owing|owed|debt|later|on credit|balance)/.test(value)) return "credit";
  return null;
}
