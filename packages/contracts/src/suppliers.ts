import { z } from "zod";
import { isUuidV7 } from "./ids.js";

/**
 * Suppliers and what is owed to them (ADR-029). Stock bought on credit adds to what a supplier is owed; paying
 * them takes it down. Every change posts to "Suppliers we owe" (ADR-013), so the suppliers' totals always equal
 * that account.
 */

const positiveMinor = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).")
  .refine((value) => BigInt(value) > 0n, "Enter an amount above zero.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-18.");
const deviceId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");

/** Stock received on credit with no supplier named goes to this one, so nothing owed goes missing. */
export const UNNAMED_SUPPLIER = "Supplier not named";

export const supplierSchema = z.object({
  id: deviceId.optional(),
  name: z.string().trim().min(2, "Enter the supplier's name.").max(160),
  /** Checked against the business's country; a number from elsewhere starts with +. */
  phone: z.string().trim().max(32).optional(),
  notes: z.string().trim().max(240).optional(),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const supplierUpdateSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the supplier's name.").max(160).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    notes: z.string().trim().max(240).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");

/** Where the money to pay a supplier came from. "owner": paid from the owner's own pocket (money put in). */
export const SUPPLIER_PAID_FROM = ["cash", "bank", "owner"] as const;
export type SupplierPaidFrom = (typeof SUPPLIER_PAID_FROM)[number];

export const supplierPaymentSchema = z.object({
  id: deviceId.optional(),
  amountMinor: positiveMinor,
  paidFrom: z.enum(SUPPLIER_PAID_FROM),
  /** For cash: whose drawer paid. Shop staff always pay from their own shop. */
  branchId: z.string().uuid().optional(),
  paymentDate: day.optional(),
  note: z.string().trim().max(240).optional(),
});
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;

/** What was already owed to a supplier before the business used Bizora. */
export const supplierOpeningSchema = z.object({
  id: deviceId.optional(),
  amountMinor: positiveMinor,
  payBy: day.optional(),
  note: z.string().trim().max(240).optional(),
});

export const SUPPLIER_ENTRY_KINDS = ["purchase", "opening", "payment"] as const;
export type SupplierEntryKind = (typeof SUPPLIER_ENTRY_KINDS)[number];
