import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { compactItemKey, savedItemKey } from "./sale-light.js";
import { FLEXIBLE_UNIT, parseQuantity } from "./stock-units.js";
import { serialListSchema } from "./stock.js";

export { compactItemKey, savedItemKey, sellsProducts, sellsTyped, TYPED_ITEM_NAME_MAX, unitPriceFromTotal } from "./sale-light.js";

export { SALE_PAGE_SIZE, IMPORT_MAX_ROWS } from "./constants.js";

/** Money a customer hands over now. Whatever is left unpaid is owed (credit) and needs a customer. */
export const PAYMENT_METHODS = ["cash", "transfer", "pos"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const quantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const flexibleUnit = z.string().trim().toLowerCase().regex(FLEXIBLE_UNIT, "Use a short unit such as piece, bag or cup.");

export const saleProductLineSchema = z.object({
  productId: z.string().uuid(),
  quantity,
  unit: flexibleUnit,
  /** Price per unit sold. Left out: the product's price for that unit. Lower than that is a discount. */
  unitPriceMinor: minorAmount.optional(),
  /** A listed product's total comes from its price and quantity. Only a typed line may send a line total. */
  lineTotalMinor: z
    .any()
    .optional()
    .refine((value) => value === undefined, { message: "A listed product's total comes from its price." }),
  /** Serial numbers or IMEIs of the units sold, for a product that keeps them (ADR-062). */
  serials: serialListSchema.optional(),
});

/** Something not in the products: a service done, or an item the shop does not list (ADR-035). */
export const saleOtherLineSchema = z.object({
  description: z.string().trim().min(1).max(160),
  quantity: quantity.default("1"),
  unitPriceMinor: minorAmount,
  /** How it was sold ("bag", "carton"); a piece when left out. */
  unit: flexibleUnit.optional(),
  /**
   * An item typed in at the counter and remembered for next time (ADR-041): sold as goods, no stock kept. Needs the
   * shop to allow typed items. Left out: a service or other income (ADR-035).
   */
  saved: z.boolean().optional(),
  /**
   * The amount for the whole line, in minor units, when the seller typed "for all" rather than a price each.
   * Stored as the line total. The unit price is only the rounded figure for display.
   */
  lineTotalMinor: minorAmount.optional(),
});

/** What staff can sell (ADR-041): only products from the list, any item typed in (remembered), or both. */
export const SALES_ITEMS = ["products", "typed", "both"] as const;
export type SalesItems = (typeof SALES_ITEMS)[number];

/** A remembered item as the app gets it. Later fields are filled in by the quick catalog (ADR-049). */
export type SavedItem = {
  id: string;
  name: string;
  unit: string;
  lastPriceMinor: string | null;
  timesSold: number;
  lastSoldAt: string | null;
  firstSoldAt?: string | null;
  source?: string;
  catalogMode?: "quick" | "managed";
  productId?: string | null;
  unitSet?: boolean;
  aliases?: string[];
};

/** How a typed line was entered. A voice sale is remembered the same way, marked as voice. */
export const ITEM_SOURCES = ["typed", "voice"] as const;
export const SAVED_ITEMS_LIMIT = 2000;

export const saleLineInputSchema = z.union([saleProductLineSchema, saleOtherLineSchema]);

export const salePaymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: minorAmount,
  reference: z.string().trim().max(64).optional(),
});

/** How a business sells (ADR-016). */
export const SALES_FLOWS = ["simple", "desk"] as const;
export type SalesFlow = (typeof SALES_FLOWS)[number];

/**
 * Where a sale is. Simple sales are completed at once. Desk sales wait for the cashier (awaiting_payment), then for
 * the store keeper to give out the goods (awaiting_release).
 */
export const SALE_STATUSES = ["awaiting_payment", "awaiting_release", "completed", "voided"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** What the customer told the sales person they will pay with. The cashier records what was actually paid. */
export const REQUESTED_PAYMENTS = ["cash", "transfer", "pos", "split", "credit"] as const;
export type RequestedPayment = (typeof REQUESTED_PAYMENTS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const comment = z.string().trim().min(1).max(500);

export const saleCreateSchema = z.object({
  id: z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.").optional(),
  /** The number the device printed while offline, e.g. DEV3-000045. */
  provisionalNumber: z.string().trim().max(24).optional(),
  customerId: z.string().uuid().optional(),
  /** Sell at a price list's prices (ADR-048). Left out, the customer's list (if any) or the everyday prices. */
  priceListId: z.string().uuid().optional(),
  lines: z.array(saleLineInputSchema).min(1).max(100),
  payments: z.array(salePaymentInputSchema).max(3).default([]),
  /** Discount on the whole sale, in kobo. */
  discountMinor: minorAmount.optional(),
  note: z.string().trim().max(240).optional(),
  /** When the sale happened on the device (offline sales). The server accepts up to 7 days back. */
  soldAt: z.string().datetime({ offset: true }).optional(),
  /** Desk flow: what the customer said they will pay with. */
  requestedPayment: z.enum(REQUESTED_PAYMENTS).optional(),
  /** When a credit sale should be paid. Needed whenever something is left owing. */
  dueDate: isoDate.optional(),
  /** A comment, saved on the sale. Needed for credit: why, and how the customer will pay. */
  comment: comment.optional(),
  /** typed: typed at the counter. voice: read from speech and confirmed. Left out on a retry is still typed. */
  itemSource: z.enum(ITEM_SOURCES).optional(),
});
export type SaleCreateInput = z.infer<typeof saleCreateSchema>;

export const saleVoidSchema = z.object({ reason: z.string().trim().min(1).max(240) });

/** The cashier takes payment, or gives credit to an approved customer, for a sale from the sales desk. */
export const saleCollectSchema = z.object({
  payments: z.array(salePaymentInputSchema).max(3).default([]),
  customerId: z.string().uuid().optional(),
  dueDate: isoDate.optional(),
  comment: comment.optional(),
});
export type SaleCollectInput = z.infer<typeof saleCollectSchema>;

/** The store keeper gives out the goods. */
export const saleReleaseSchema = z.object({ comment: comment.optional() });

export const saleCommentSchema = z.object({ body: comment });

export const notificationReadSchema = z.object({ ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() });

/** How imported sales are treated: counted fully (stock and accounts) or kept as history only. */
export const SALE_IMPORT_MODES = ["mixed", "full", "history"] as const;
export type SaleImportMode = (typeof SALE_IMPORT_MODES)[number];

const importCell = z.string().max(200).optional().default("");

/** Where import rows came from: a file, or AI capture checked by a person (ADR-018). */
export const IMPORT_SOURCES = ["file", "capture"] as const;

export const productImportSchema = z.object({
  dryRun: z.boolean().default(true),
  source: z.enum(IMPORT_SOURCES).default("file"),
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
  source: z.enum(IMPORT_SOURCES).default("file"),
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

/** How a delivery was paid for, from words traders write ("owed", "cash", "trf"). Empty means owed to the supplier. */
export function paidFromText(text: string): "cash" | "bank" | "credit" | null {
  const value = text.trim().toLowerCase();
  if (!value || /^(credit|owe|owing|owed|not paid|unpaid|later|balance|supplier)/.test(value)) return "credit";
  if (["cash", "csh"].includes(value) || value.startsWith("cash")) return "cash";
  if (/^(bank|transfer|trf|trans|xfer|pos|card|online)/.test(value)) return "bank";
  return null;
}

/** A supplier delivery: rows of stock received (ADR-018). */
export const stockInImportSchema = z.object({
  dryRun: z.boolean().default(true),
  source: z.enum(IMPORT_SOURCES).default("file"),
  rows: z
    .array(
      z.object({
        product: importCell,
        quantity: importCell,
        unit: importCell,
        cost: importCell,
        supplier: importCell,
        paid: importCell,
        ref: importCell,
      }),
    )
    .min(1)
    .max(5000),
});

const stockRows = <F extends string>(fields: readonly F[]) =>
  z.object({
    dryRun: z.boolean().default(true),
    source: z.enum(IMPORT_SOURCES).default("file"),
    rows: z
      .array(z.object(Object.fromEntries(fields.map((field) => [field, importCell])) as Record<F, typeof importCell>))
      .min(1)
      .max(5000),
  });

/** Spoken, photographed or file lists of stock counts, changes and moves (ADR-033). */
export const stockCountImportSchema = stockRows(["product", "counted", "unit", "note"] as const);
export const stockChangeImportSchema = stockRows(["product", "change", "reason", "quantity", "unit", "note"] as const);
export const stockMoveImportSchema = stockRows(["product", "quantity", "unit", "toShop", "note"] as const);

/** Why a suggestion matched. A partial match is shown, never chosen on its own. */
export type SaleMatchVia = "exact" | "prefix" | "alias" | "partial";

export type SaleMatchInput<T> = {
  item: T;
  name: string;
  aliases?: string[];
  codes?: (string | null | undefined)[];
  timesSold?: number;
  lastSoldAt?: string | null;
  /** A product from the list ranks just ahead of a remembered item when the match is otherwise the same. */
  managed?: boolean;
};

const WEEK_MS = 7 * 86_400_000;

/**
 * Ranks what the sales search should show (ADR-049). An exact name or an exact alias comes first, then a prefix,
 * then a shorter alias, then a partial match. Recently and frequently sold names come first inside each of those.
 * A partial match is only a suggestion. The screen chooses an exact listed product when the seller presses Enter.
 */
export function matchSaleItems<T>(query: string, items: SaleMatchInput<T>[], limit = 8, now = Date.now()) {
  const asked = savedItemKey(query);
  if (!asked) return [] as { item: T; via: SaleMatchVia; score: number }[];
  const askedCode = query.trim().toLowerCase();
  const recentAfter = now - WEEK_MS;
  const ranked: { item: T; via: SaleMatchVia; score: number; exact: boolean }[] = [];
  for (const entry of items) {
    const key = savedItemKey(entry.name);
    const aliasKeys = (entry.aliases ?? []).map((alias) => savedItemKey(alias));
    const compact = compactItemKey(query);
    const nameCompact = compactItemKey(entry.name);
    const aliasCompacts = (entry.aliases ?? []).map((alias) => compactItemKey(alias));
    const codeHit = (entry.codes ?? []).some((code) => code?.trim().toLowerCase() === askedCode);
    const nameExact = Boolean(codeHit || key === asked || (compact.length > 0 && nameCompact === compact));
    const aliasExact = aliasKeys.some((alias) => alias === asked) || (compact.length > 0 && aliasCompacts.some((alias) => alias === compact));
    let via: SaleMatchVia | null = null;
    if (nameExact) via = "exact";
    else if (aliasExact) via = "alias";
    else if (key.startsWith(asked)) via = "prefix";
    else if (aliasKeys.some((alias) => alias.startsWith(asked))) via = "alias";
    else if (asked.length >= 2 && (key.includes(asked) || aliasKeys.some((alias) => alias.includes(asked)))) via = "partial";
    if (!via) continue;
    const base = nameExact || aliasExact ? 500 : via === "prefix" ? 400 : via === "alias" ? 300 : 200;
    const soldAt = entry.lastSoldAt ? Date.parse(entry.lastSoldAt) : Number.NaN;
    const recent = Number.isFinite(soldAt) && soldAt >= recentAfter ? 40 : 0;
    ranked.push({ item: entry.item, via, exact: nameExact || aliasExact, score: base + Math.min(entry.timesSold ?? 0, 80) + recent + (entry.managed ? 10 : 0) });
  }
  ranked.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  return ranked.slice(0, limit).map(({ item, via, score }) => ({ item, via, score }));
}

/** True when the typed text is exactly this listed product's name or one of its other names. A prefix is not exact. */
export function isExactListedName(query: string, name: string, aliases: string[] = []) {
  const asked = savedItemKey(query);
  const compact = compactItemKey(query);
  if (!asked && !compact) return false;
  if (asked && (savedItemKey(name) === asked || aliases.some((alias) => savedItemKey(alias) === asked))) return true;
  if (!compact) return false;
  return compactItemKey(name) === compact || aliases.some((alias) => compactItemKey(alias) === compact);
}
