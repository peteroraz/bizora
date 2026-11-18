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
  otherIncomeMinor: string;
  expensesMinor: string;
  profitMinor: string;
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
