import { z } from "zod";

/**
 * Bank statements and the reconciliation inbox (ADR-020). Statement lines of money in are matched to payments
 * already recorded, to debtors, or classified. Bizora never moves money; it reads, matches and records.
 */
export const STATEMENT_IMPORT_COLUMNS = {
  date: ["date", "trans date", "transaction date", "value date", "txn date", "tran date", "posting date", "date posted", "trans time", "transaction time"],
  description: ["description", "narration", "details", "remarks", "transaction details", "particulars", "narrative", "memo", "transaction description"],
  reference: ["reference", "ref", "ref no", "reference number", "transaction reference", "session id", "cheque no", "transaction id", "trans ref"],
  moneyIn: ["credit", "credits", "credit amount", "money in", "deposit", "deposits", "lodgement", "lodgements", "inflow", "cr", "credit ngn", "amount in", "amount"],
  moneyOut: ["debit", "debits", "debit amount", "money out", "withdrawal", "withdrawals", "outflow", "dr", "debit ngn", "amount out"],
} as const;
export type StatementImportField = keyof typeof STATEMENT_IMPORT_COLUMNS;

const cell = z.string().max(500).default("");

export const statementImportSchema = z.object({
  dryRun: z.boolean().default(true),
  source: z.enum(["file", "capture"]).default("file"),
  /** Which account the statement is for, as the owner calls it ("GTBank 0123", "Moniepoint"). */
  accountLabel: z.string().trim().min(1, "Say which account this statement is for.").max(80),
  rows: z
    .array(z.object({ date: cell, description: cell, reference: cell, moneyIn: cell, moneyOut: cell }))
    .min(1)
    .max(5000),
});

/** What money in can be, when it is not a customer paying what they owe (Cr side of the entry). */
export const MONEY_IN_CATEGORIES = ["unrecorded_sales", "owner_capital", "other_income"] as const;
/** Money that moved between the business's own accounts: never income. */
export const OWN_TRANSFER_SOURCES = ["pos_settlement", "cash_deposit", "other_account"] as const;

export const reconcileTargetSchema = z.discriminatedUnion("kind", [
  /** A transfer already recorded at the counter or as a debtor payment: link only, nothing new is posted. */
  z.object({ kind: z.literal("recorded_payment"), paymentType: z.enum(["sale_payment", "customer_payment"]), paymentId: z.string().uuid() }),
  /** A debtor paying: recorded as their payment; anything above what they owe is kept as an advance. */
  z.object({ kind: z.literal("debtor"), customerId: z.string().uuid() }),
  /** Money paid ahead by a customer, kept as their advance. */
  z.object({ kind: z.literal("advance"), customerId: z.string().uuid() }),
  z.object({ kind: z.literal("money_in"), category: z.enum(MONEY_IN_CATEGORIES) }),
  z.object({ kind: z.literal("own_transfer"), source: z.enum(OWN_TRANSFER_SOURCES), branchId: z.string().uuid().optional() }),
  z.object({ kind: z.literal("ignored"), reason: z.string().trim().min(1).max(200) }),
]);
export type ReconcileTarget = z.infer<typeof reconcileTargetSchema>;

export const reconcileSchema = z.object({
  target: reconcileTargetSchema,
  /** Save "always do this" for lines whose description contains this text (e.g. the payer's name). */
  rulePattern: z.string().trim().min(3).max(80).optional(),
});

export const RECONCILE_STATUSES = ["open", "matched", "ignored"] as const;
