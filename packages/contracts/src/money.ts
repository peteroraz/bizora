import { z } from "zod";
import { isUuidV7 } from "./ids.js";

/**
 * Money in and out (ADR-028): expenses, the owner's money and moves between the drawer and the bank, counting the
 * cash in each shop, and profit. Every one of them posts a balanced ledger entry (ADR-013); traders see plain words.
 */

const positiveMinor = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).")
  .refine((value) => BigInt(value) > 0n, "Enter an amount above zero.");

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-18.");
const deviceId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");

/** Where the money for an expense came from. "owner": the owner paid from their own pocket (money put in). */
export const EXPENSE_PAID_FROM = ["cash", "bank", "owner"] as const;
export type ExpensePaidFrom = (typeof EXPENSE_PAID_FROM)[number];

export const EXPENSE_STATUSES = ["awaiting_approval", "approved", "voided"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const expenseSchema = z.object({
  id: deviceId.optional(),
  /** The expense category: one of the business's expense accounts (GET /money/categories). */
  categoryId: z.string().uuid(),
  amountMinor: positiveMinor,
  paidFrom: z.enum(EXPENSE_PAID_FROM),
  /** The shop it was for (and whose drawer paid, for cash). Shop staff always record for their own shop. */
  branchId: z.string().uuid().optional(),
  /** The day it was paid, in the business's time zone. Today when left out; never in the future. */
  expenseDate: day.optional(),
  payee: z.string().trim().max(120).optional(),
  note: z.string().trim().max(240).optional(),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const moneyReasonSchema = z.object({ reason: z.string().trim().min(3, "Say why, in a few words.").max(240) });

/**
 * Other money in and out of a shop's drawer or the bank:
 * - owner_in: the owner puts money into the drawer; owner_out: the owner takes money out for themselves;
 * - to_bank: cash from the drawer paid into the bank; from_bank: cash drawn from the bank into the drawer;
 * - other_in: money in that is not a sale or a debt payment (a refund from a supplier, a grant).
 */
export const MONEY_MOVEMENT_KINDS = ["owner_in", "owner_out", "to_bank", "from_bank", "other_in", "pos_cashout"] as const;
/** The moves shown on the "Move money" screen. POS cash-out has its own screen; other money in is not offered. */
export const MOVE_SCREEN_KINDS = ["to_bank", "from_bank", "owner_in", "owner_out"] as const satisfies readonly MoneyMovementKind[];
export type MoneyMovementKind = (typeof MONEY_MOVEMENT_KINDS)[number];

export const moneyMovementSchema = z.object({
  id: deviceId.optional(),
  kind: z.enum(MONEY_MOVEMENT_KINDS).exclude(["pos_cashout"]),
  amountMinor: positiveMinor,
  branchId: z.string().uuid().optional(),
  movementDate: day.optional(),
  note: z.string().trim().max(240).optional(),
});
export type MoneyMovementInput = z.infer<typeof moneyMovementSchema>;

/**
 * A POS cash-out (ADR-038): a customer pays on the shop's POS machine (Moniepoint, OPay and the like) and the shop
 * gives them cash from the drawer, for a fee. The fee is either added on the POS or paid in cash. The fee is profit;
 * the cash given is not a cost, it moves from the drawer to the POS account.
 */
export const posCashoutSchema = z
  .object({
    id: deviceId.optional(),
    amountMinor: positiveMinor,
    feeMinor: z.string().trim().regex(/^\d{1,15}$/, "Enter the fee, or 0.").default("0"),
    feePaidBy: z.enum(["pos", "cash"]).default("pos"),
    branchId: z.string().uuid().optional(),
    movementDate: day.optional(),
    note: z.string().trim().max(240).optional(),
  })
  .refine((value) => BigInt(value.feeMinor) <= BigInt(value.amountMinor), { path: ["feeMinor"], message: "The fee cannot be more than the cash given." });
export type PosCashoutInput = z.infer<typeof posCashoutSchema>;

/** The cash counted in a shop's drawer. The person counting does not see what was expected (a blind count). */
export const cashCountSchema = z.object({
  id: deviceId.optional(),
  branchId: z.string().uuid().optional(),
  countedMinor: z.string().trim().regex(/^\d{1,15}$/, "Enter what you counted."),
  note: z.string().trim().max(240).optional(),
});
export type CashCountInput = z.infer<typeof cashCountSchema>;

/** Up to a year of profit at once; one line per day up to 62 days. */
export const PROFIT_MAX_DAYS = 366;
export const PROFIT_DAILY_MAX_DAYS = 62;

/** Where cash in a drawer came from or went to on a day, by what caused it. */
export const CASH_FLOW_KINDS = [
  "sales",
  "refunds",
  "debt_payments",
  "expenses",
  "owner",
  "bank",
  "other_in",
  "pos_cashout",
  "stock_bought",
  "suppliers",
  "counts",
  // Jobs (ADR-035): deposits taken before a job is finished, and helpers paid for a job.
  "deposits",
  "job_costs",
  "other",
] as const;
export type CashFlowKind = (typeof CASH_FLOW_KINDS)[number];
