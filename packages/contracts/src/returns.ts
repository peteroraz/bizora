import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { decimalQuantity, serialListSchema, unitCodeSchema } from "./stock.js";

/**
 * Returns (ADR-030): goods a customer brings back, and goods sent back to a supplier. Each posts a balanced entry
 * (ADR-013) and moves the stock, so the books and the shelves stay in step.
 */

const deviceId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");

/** How a customer is paid back. Money still owed on the sale is taken off first, whatever is chosen. */
export const RETURN_REFUND_METHODS = ["cash", "transfer"] as const;
export type ReturnRefundMethod = (typeof RETURN_REFUND_METHODS)[number];

export const saleReturnSchema = z.object({
  id: deviceId.optional(),
  lines: z
    .array(
      z.object({
        saleLineId: z.string().uuid(),
        /** In the unit the line was sold in (2 cartons, 1.5 kg). */
        quantity: decimalQuantity,
        /** False when the goods cannot be sold again (broken, expired): they do not go back on the shelf. */
        backToStock: z.boolean().default(true),
        /** Which units came back, for a product that keeps serial numbers (ADR-062). */
        serials: serialListSchema.optional(),
      }),
    )
    .min(1, "Choose what is coming back.")
    .max(100),
  refundMethod: z.enum(RETURN_REFUND_METHODS).default("cash"),
  reason: z.string().trim().min(3, "Say why, in a few words.").max(240),
});
export type SaleReturnInput = z.infer<typeof saleReturnSchema>;

/** How a supplier settles goods sent back: off what is owed to them, or money back in cash or to the bank. */
export const SUPPLIER_RETURN_SETTLEMENTS = ["owed", "cash", "bank"] as const;
export type SupplierReturnSettlement = (typeof SUPPLIER_RETURN_SETTLEMENTS)[number];

export const supplierReturnSchema = z.object({
  id: deviceId.optional(),
  productId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  supplierId: z.string().uuid(),
  quantity: decimalQuantity,
  unit: unitCodeSchema,
  settle: z.enum(SUPPLIER_RETURN_SETTLEMENTS).default("owed"),
  note: z.string().trim().max(240).optional(),
});
export type SupplierReturnInput = z.infer<typeof supplierReturnSchema>;
