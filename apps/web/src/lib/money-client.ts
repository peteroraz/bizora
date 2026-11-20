import type { CashFlowKind, ExpensePaidFrom, ExpenseStatus, MoneyMovementKind } from "@bizora/contracts";

/** Shapes of the money API (ADR-028). Amounts are whole minor units as strings. */

export type ExpenseItem = {
  id: string;
  categoryId: string;
  category: string;
  branchId: string;
  shop: string;
  amountMinor: string;
  paidFrom: ExpensePaidFrom;
  expenseDate: string;
  payee: string | null;
  note: string | null;
  status: ExpenseStatus;
  voidReason: string | null;
  recordedBy: string | null;
  createdAt: string;
  canApprove: boolean;
  canCancel: boolean;
};

export type ExpenseList = {
  currency: string;
  today: string;
  from: string | null;
  to: string | null;
  totalMinor: string;
  awaiting: number;
  byCategory: { categoryId: string; name: string; amountMinor: string }[];
  items: ExpenseItem[];
};

export type MoneyMove = {
  id: string;
  branchId: string;
  kind: MoneyMovementKind;
  amountMinor: string;
  /** POS cash-outs only (ADR-038): the fee, and whether it was added on the POS or paid in cash. */
  feeMinor: string;
  feePaidBy: "pos" | "cash" | null;
  movementDate: string;
  note: string | null;
  status: "recorded" | "voided";
  voidReason: string | null;
  createdAt: string;
};

export type CashShop = {
  branchId: string;
  name: string;
  openingMinor: string;
  inMinor: string;
  outMinor: string;
  expectedMinor: string;
  flows: { kind: CashFlowKind; inMinor: string; outMinor: string }[];
  counts: { id: string; at: string; by: string | null; note: string | null; expectedMinor: string; countedMinor: string; differenceMinor: string }[];
  moves: MoneyMove[];
};

export type CashPosition = { currency: string; date: string; today: string; shops: CashShop[] };

export type ProfitFigures = {
  salesMinor: string;
  discountsMinor: string;
  returnsMinor: string;
  netSalesMinor: string;
  costOfSalesMinor: string;
  grossProfitMinor: string;
  posCashoutFeesMinor: string;
  expensesMinor: string;
  profitMinor: string;
  /** Money in that is not from sales (cash found in counts, other money in). Never part of profit (ADR-038). */
  notFromSalesMinor: string;
};

export type Profit = ProfitFigures & {
  currency: string;
  today: string;
  from: string;
  to: string;
  expenses: { name: string; amountMinor: string }[];
  expensesAwaitingApproval: number;
  days: (ProfitFigures & { date: string })[] | null;
};

/** An API error's plain message, or the fallback. */
export async function problemOf(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  return (payload?.error?.message as string | undefined) ?? fallback;
}

/** A transfer waiting for confirmation, or one checked lately (ADR-031). */
export type TransferItem = {
  kind: "sale_payment" | "customer_payment";
  id: string;
  amountMinor: string;
  reference: string | null;
  number: string | null;
  saleId: string | null;
  customerId: string | null;
  customerName: string | null;
  branchName: string | null;
  recordedByName: string | null;
  recordedAt: string;
  confirmation: "confirmed" | "waiting" | "not_received";
  confirmedVia: "by_hand" | "bank_statement" | null;
  notReceivedAs: "owed" | "lost" | null;
  checkedByName: string | null;
  checkedAt: string | null;
  note: string | null;
};

export type TransferList = { waiting: TransferItem[]; waitingCount: number; waitingMinor: string; recent: TransferItem[] };

/** Discounts and cancellations for a day or a month (ADR-031). */
export type DiscountsReport = {
  currency: string;
  today: string;
  from: string;
  to: string;
  totals: { discountsMinor: string; cancelledSalesMinor: string; returnsMinor: string; paymentsCancelledMinor: string; transfersNotReceivedMinor: string };
  people: {
    name: string;
    discountsMinor: string;
    discountCount: number;
    cancelledMinor: string;
    cancelledCount: number;
    returnsMinor: string;
    returnsCount: number;
    lostMinor: string;
    lostCount: number;
  }[];
  discounts: { saleId: string; number: string | null; at: string | null; totalMinor: string; discountMinor: string; loweredMinor: string; givenMinor: string; customerName: string | null; byName: string | null }[];
  cancellations: { saleId: string; number: string | null; at: string | null; soldAt: string | null; totalMinor: string; paid: boolean; reason: string | null; customerName: string | null; soldByName: string | null; byName: string | null }[];
  returns: { id: string; number: string; saleId: string; saleNumber: string | null; at: string | null; totalMinor: string; reason: string; customerName: string | null; byName: string | null }[];
  paymentsCancelled: { id: string; number: string; at: string | null; amountMinor: string; method: string; reason: string | null; customerName: string | null; byName: string | null }[];
  transfersNotReceived: { kind: "sale_payment" | "customer_payment"; id: string; number: string | null; saleId: string | null; at: string | null; amountMinor: string; settle: string; reason: string | null; customerName: string | null; byName: string | null }[];
};
