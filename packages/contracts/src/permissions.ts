/** Every permission in Bizora. Roles get them through role_permissions (see access.ts). */
export const Permission = {
  TENANT_READ: "tenant.read",
  TENANT_MANAGE: "tenant.manage",
  BRANDING_MANAGE: "branding.manage",
  USERS_READ: "users.read",
  USERS_INVITE: "users.invite",
  USERS_MANAGE: "users.manage",
  ONBOARDING_COMPLETE: "onboarding.complete",
  BRANCHES_READ: "branches.read",
  BRANCHES_MANAGE: "branches.manage",
  ORG_SETTINGS_MANAGE: "org.settings.manage",
  BUSINESS_SETTINGS_MANAGE: "business.settings.manage",
  BRANCH_SETTINGS_MANAGE: "branch.settings.manage",
  STAFF_MANAGE: "staff.manage",
  DEVICES_MANAGE: "devices.manage",

  // Customers
  CUSTOMERS_READ: "customers.read",
  CUSTOMERS_LOOKUP: "customers.lookup",
  CUSTOMERS_MANAGE: "customers.manage",
  /** Add a new or walk-in customer while recording a sale (ADR-019). Does not allow seeing or editing others. */
  CUSTOMERS_ADD: "customers.add",
  CUSTOMERS_EXPORT: "customers.export",
  FOLLOWUPS_MANAGE: "followups.manage",
  FOLLOWUPS_READ_ALL: "followups.read.all",

  // Sales and payments (Sales module)
  SALES_CREATE: "sales.create",
  SALES_READ_OWN: "sales.read.own",
  SALES_READ_ALL: "sales.read.all",
  SALES_DISCOUNT: "sales.discount",
  SALES_VOID: "sales.void",
  /** Desk flow (ADR-016): take payment for sales the sales desk sent to the cashier. */
  SALES_COLLECT: "sales.collect",
  /** Desk flow: give out the goods once a sale is paid or approved for credit. */
  SALES_RELEASE: "sales.release",
  /** Sell on credit to customers approved for credit, within their limit. Approving customers needs debtors.manage. */
  SALES_CREDIT: "sales.credit",
  PAYMENTS_RECORD: "payments.record",
  CASH_CLOSE: "cash.close",
  CASH_EXPECTED_READ: "cash.expected.read",

  // Debtors
  DEBTORS_READ: "debtors.read",
  DEBTORS_MANAGE: "debtors.manage",

  // Stock and products
  STOCK_READ: "stock.read",
  STOCK_RECEIVE: "stock.receive",
  STOCK_COUNT: "stock.count",
  STOCK_TRANSFER: "stock.transfer",
  STOCK_ADJUST: "stock.adjust",
  PRODUCTS_MANAGE: "products.manage",
  PRICES_COST_READ: "prices.cost.read",
  /** Make and change price lists, and give customers one (ADR-048). */
  PRICING_LISTS_MANAGE: "pricing.lists.manage",
  PURCHASES_MANAGE: "purchases.manage",

  // Money
  MONEY_READ: "money.read",
  /** Upload bank statements and match or classify their lines (ADR-020). */
  BANK_RECONCILE: "bank.reconcile",
  EXPENSES_RECORD: "expenses.record",
  EXPENSES_APPROVE: "expenses.approve",

  // Reports and oversight
  REPORTS_SALES_READ: "reports.sales.read",
  REPORTS_STOCK_READ: "reports.stock.read",
  REPORTS_PROFIT_READ: "reports.profit.read",
  AUDIT_READ: "audit.read",
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];
