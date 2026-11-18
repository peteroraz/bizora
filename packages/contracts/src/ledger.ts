import type { BusinessType } from "./trader.js";

/**
 * Accounting core (ADR-013). Traders never see these words; the UI uses plain labels.
 * Every financial event posts a balanced journal entry through LedgerPostingService.
 */
export const LEDGER_ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

/** What an account is for. Posting rules find accounts by role (and branch for cash), never by name. */
export type LedgerRole =
  | "cash"
  | "bank"
  | "pos_clearing"
  | "transfer_clearing"
  | "debtors"
  | "stock"
  | "payable"
  | "customer_deposits"
  | "capital"
  | "drawings"
  | "retained"
  | "sales"
  | "service_income"
  | "discounts"
  | "sales_returns"
  | "other_income"
  | "cogs"
  | "stock_loss"
  | "materials"
  | "expense"
  | "bank_charges"
  | "cash_over_short"
  | "transfers_waiting"
  | "transfers_lost"
  | "fx";

export type AccountTemplate = { code: string; name: string; type: LedgerAccountType; role: LedgerRole };

/** Cash accounts are one per shop: 1000-01, 1000-02, … */
export function cashAccountCode(branchNumber: number): string {
  return `1000-${branchNumber.toString().padStart(2, "0")}`;
}

export function cashAccountName(branchName: string): string {
  return `Cash at ${branchName}`.slice(0, 120);
}

const base: AccountTemplate[] = [
  { code: "1100", name: "Bank accounts", type: "asset", role: "bank" },
  { code: "1150", name: "POS and transfer payments to receive", type: "asset", role: "pos_clearing" },
  { code: "1160", name: "Transfers waiting for confirmation", type: "asset", role: "transfers_waiting" },
  { code: "1190", name: "Money moving between own accounts", type: "asset", role: "transfer_clearing" },
  { code: "1200", name: "Customers who owe", type: "asset", role: "debtors" },
  { code: "2000", name: "Suppliers we owe", type: "liability", role: "payable" },
  { code: "2100", name: "Customer advance payments", type: "liability", role: "customer_deposits" },
  { code: "3000", name: "Owner's money put in", type: "equity", role: "capital" },
  { code: "3100", name: "Owner's withdrawals", type: "equity", role: "drawings" },
  { code: "3200", name: "Profit kept in the business", type: "equity", role: "retained" },
  { code: "4100", name: "Discounts given", type: "income", role: "discounts" },
  // Money given back for goods customers returned (ADR-030). Like discounts, it lowers sales.
  { code: "4150", name: "Returns from customers", type: "income", role: "sales_returns" },
  { code: "4900", name: "Other money in", type: "income", role: "other_income" },
  { code: "6000", name: "Rent", type: "expense", role: "expense" },
  { code: "6100", name: "Salaries and wages", type: "expense", role: "expense" },
  { code: "6200", name: "Transport and delivery", type: "expense", role: "expense" },
  { code: "6300", name: "Electricity and fuel", type: "expense", role: "expense" },
  { code: "6400", name: "Phone and data", type: "expense", role: "expense" },
  { code: "6500", name: "Repairs and maintenance", type: "expense", role: "expense" },
  { code: "6600", name: "Bank and POS charges", type: "expense", role: "bank_charges" },
  { code: "6700", name: "Market levies and dues", type: "expense", role: "expense" },
  { code: "6900", name: "Other expenses", type: "expense", role: "expense" },
  // A drawer that counts more or less than expected (ADR-028). Short is a cost; over lowers it.
  { code: "6950", name: "Cash short or over", type: "expense", role: "cash_over_short" },
  { code: "6960", name: "Transfers that never arrived", type: "expense", role: "transfers_lost" },
  { code: "7000", name: "Exchange rate gains and losses", type: "expense", role: "fx" },
];

const goods: AccountTemplate[] = [
  { code: "1300", name: "Stock", type: "asset", role: "stock" },
  { code: "4000", name: "Sales", type: "income", role: "sales" },
  { code: "5000", name: "Cost of goods sold", type: "expense", role: "cogs" },
  { code: "5100", name: "Stock lost or damaged", type: "expense", role: "stock_loss" },
  { code: "6800", name: "Packaging", type: "expense", role: "expense" },
];

const extras: Record<BusinessType, AccountTemplate[]> = {
  shop: [],
  "market-stall": [],
  wholesale: [{ code: "6250", name: "Loading and offloading", type: "expense", role: "expense" }],
  pharmacy: [],
  fashion: [],
  electronics: [],
  building: [{ code: "6250", name: "Loading and offloading", type: "expense", role: "expense" }],
  food: [{ code: "6810", name: "Gas and cooking fuel", type: "expense", role: "expense" }],
  services: [
    { code: "4000", name: "Service income", type: "income", role: "service_income" },
    { code: "5050", name: "Materials used", type: "expense", role: "materials" },
  ],
  other: [],
};

/** Default chart of accounts for a business type, without the per-shop cash accounts. Sorted by code. */
export function chartOfAccountsTemplate(type: BusinessType): AccountTemplate[] {
  const accounts = [...base, ...(type === "services" ? [] : goods), ...extras[type]].map((account) => ({ ...account }));
  if (type === "food") {
    const cogs = accounts.find((account) => account.role === "cogs");
    if (cogs) cogs.name = "Cost of food and drinks sold";
  }
  return accounts.sort((a, b) => a.code.localeCompare(b.code));
}
