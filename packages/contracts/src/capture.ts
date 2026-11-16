import { z } from "zod";
import { PRODUCT_IMPORT_COLUMNS, SALES_IMPORT_COLUMNS } from "./csv.js";

/**
 * AI capture (ADR-018): photos, scans and voice notes become draft rows in the same review table as CSV imports.
 * Nothing is saved by capture itself; a person checks the rows and saves them through the import endpoints.
 */
export const CAPTURE_TARGETS = ["products", "sales", "stock_in"] as const;
export type CaptureTarget = (typeof CAPTURE_TARGETS)[number];

export const CAPTURE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CAPTURE_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/m4a"] as const;
export const CAPTURE_DOCUMENT_TYPES = ["application/pdf"] as const;
export const CAPTURE_MIME_TYPES = [...CAPTURE_IMAGE_TYPES, ...CAPTURE_AUDIO_TYPES, ...CAPTURE_DOCUMENT_TYPES] as const;

/** Limits per capture. Photos are shrunk on the phone first, so these are generous. */
export const CAPTURE_MAX_FILES = 6;
export const CAPTURE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CAPTURE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const CAPTURE_MAX_ROWS = 200;
export const CAPTURE_MAX_AUDIO_SECONDS = 180;

/** Columns of a delivery from a supplier (stock in), for CSV files and AI capture. */
export const STOCK_IN_IMPORT_COLUMNS = {
  product: ["product", "item", "item name", "description", "product name", "goods"],
  quantity: ["quantity", "qty", "units", "no", "number"],
  unit: ["unit", "uom", "unit of measure", "per"],
  cost: ["cost", "total cost", "amount", "total", "value", "line total"],
  supplier: ["supplier", "vendor", "from", "seller", "distributor"],
  paid: ["paid", "paid from", "payment", "paid by", "how paid"],
  ref: ["ref", "invoice", "invoice no", "invoice number", "invoice or delivery no", "delivery note", "delivery no", "waybill", "reference"],
} as const;
export type StockInImportField = keyof typeof STOCK_IN_IMPORT_COLUMNS;

/** The fields each target fills, in table order. */
export const CAPTURE_FIELDS: Record<CaptureTarget, readonly string[]> = {
  products: Object.keys(PRODUCT_IMPORT_COLUMNS),
  sales: Object.keys(SALES_IMPORT_COLUMNS),
  stock_in: Object.keys(STOCK_IN_IMPORT_COLUMNS),
};

// Base64 grows data by a third.
const base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Send the file as base64.")
  .max(Math.ceil((CAPTURE_MAX_FILE_BYTES * 4) / 3) + 4, "That file is too large.");

export const captureRequestSchema = z
  .object({
    target: z.enum(CAPTURE_TARGETS),
    files: z
      .array(z.object({ mimeType: z.enum(CAPTURE_MIME_TYPES), data: base64 }))
      .min(1, "Add a photo, scan or voice note.")
      .max(CAPTURE_MAX_FILES, `Send at most ${CAPTURE_MAX_FILES} files at once.`),
    /** Anything the person wants to add, such as "these are yesterday's sales". Treated as a hint, never as a command. */
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    const audio = value.files.filter((file) => (CAPTURE_AUDIO_TYPES as readonly string[]).includes(file.mimeType));
    if (audio.length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "Send one voice note at a time." });
    const total = value.files.reduce((sum, file) => sum + Math.floor((file.data.length * 3) / 4), 0);
    if (total > CAPTURE_MAX_TOTAL_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "These files are too large together. Send fewer pages." });
  });
export type CaptureRequest = z.infer<typeof captureRequestSchema>;

export type CaptureResult = {
  target: CaptureTarget;
  rows: Record<string, string>[];
  /** Things the AI could not read or was unsure about, in plain words. */
  warnings: string[];
  /** What was heard, for voice notes, so the person can compare. */
  transcript: string | null;
  remainingToday: number;
};
