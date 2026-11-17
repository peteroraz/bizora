import { z } from "zod";
import { PAYMENT_METHODS } from "./sales.js";
import { isUuidV7 } from "./ids.js";

/**
 * Debtors and payments (ADR-019). A payment is applied to the customer's credit sales, oldest due first unless a
 * sale is chosen. A customer can never pay more than they owe here; change is given from the drawer.
 */
export const customerPaymentSchema = z.object({
  /** UUIDv7 made on the device, so a payment recorded offline syncs once. */
  id: z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.").optional(),
  amountMinor: z
    .string()
    .trim()
    .regex(/^\d{1,15}$/, "Enter an amount in kobo.")
    .refine((value) => BigInt(value) > 0n, "Enter an amount above zero."),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(240).optional(),
  /** Pay this sale only. Without it, the oldest debts are paid first. */
  saleId: z.string().uuid().optional(),
  /** When the money was received on the device (offline payments). Up to 7 days back. */
  receivedAt: z.string().datetime({ offset: true }).optional(),
});
export type CustomerPaymentInput = z.infer<typeof customerPaymentSchema>;

export const paymentVoidSchema = z.object({ reason: z.string().trim().min(1).max(240) });

export const DEBTOR_FILTERS = ["all", "overdue"] as const;
export type DebtorFilter = (typeof DEBTOR_FILTERS)[number];
