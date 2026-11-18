import { z } from "zod";

/**
 * Transfers waiting for confirmation (ADR-031). A transfer recorded by staff who cannot see the bank is held until
 * someone who can (bank.reconcile) checks it came in, or a bank statement line matches it.
 */

/** A payment taken with a sale, or a later payment from a customer who owes. */
export const TRANSFER_KINDS = ["sale_payment", "customer_payment"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export const TRANSFER_CONFIRMATIONS = ["confirmed", "waiting", "not_received"] as const;
export type TransferConfirmation = (typeof TRANSFER_CONFIRMATIONS)[number];

/**
 * What happens to a transfer that never came. On a sale with a customer it can stay owed by them; otherwise it is
 * written off as lost. A later payment from a customer who owes is simply cancelled, so they owe it again.
 */
export const NOT_RECEIVED_AS = ["owed", "lost"] as const;
export type NotReceivedAs = (typeof NOT_RECEIVED_AS)[number];

export const transferConfirmSchema = z
  .object({
    note: z.string().trim().max(240).optional(),
  })
  .strict();

export const transferNotReceivedSchema = z
  .object({
    settle: z.enum(NOT_RECEIVED_AS).default("owed"),
    reason: z.string().trim().min(3, "Say what happened, in a few words.").max(240),
  })
  .strict();

export type TransferNotReceivedInput = z.infer<typeof transferNotReceivedSchema>;
