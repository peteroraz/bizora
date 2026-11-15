import { Permission as P, type PermissionCode } from "./permissions.js";

type RoleName =
  | "OWNER"
  | "ADMINISTRATOR"
  | "MANAGER"
  | "SALES"
  | "CASHIER"
  | "INVENTORY"
  | "ACCOUNTANT"
  | "EMPLOYEE"
  | "AUDITOR";

/** A cashier's counter search must have at least this many characters (no browsing the customer list). */
export const LOOKUP_MIN_QUERY = 3;
/** A counter search returns at most this many customers. */
export const LOOKUP_RESULT_LIMIT = 10;

const base: PermissionCode[] = [P.TENANT_READ, P.BRANCHES_READ];

const settingsAll: PermissionCode[] = [
  P.TENANT_MANAGE,
  P.BRANDING_MANAGE,
  P.USERS_READ,
  P.USERS_INVITE,
  P.USERS_MANAGE,
  P.ONBOARDING_COMPLETE,
  P.BRANCHES_MANAGE,
  P.ORG_SETTINGS_MANAGE,
  P.BUSINESS_SETTINGS_MANAGE,
  P.BRANCH_SETTINGS_MANAGE,
  P.STAFF_MANAGE,
  P.DEVICES_MANAGE,
];

/** Read-only view of figures: what an accountant and an auditor share. */
const readFigures: PermissionCode[] = [
  P.CUSTOMERS_READ,
  P.FOLLOWUPS_READ_ALL,
  P.SALES_READ_ALL,
  P.CASH_EXPECTED_READ,
  P.DEBTORS_READ,
  P.STOCK_READ,
  P.PRICES_COST_READ,
  P.MONEY_READ,
  P.REPORTS_SALES_READ,
  P.REPORTS_STOCK_READ,
  P.REPORTS_PROFIT_READ,
];

const runTheShop: PermissionCode[] = [
  P.CUSTOMERS_READ,
  P.CUSTOMERS_MANAGE,
  P.FOLLOWUPS_MANAGE,
  P.FOLLOWUPS_READ_ALL,
  P.SALES_CREATE,
  P.SALES_READ_ALL,
  P.SALES_DISCOUNT,
  P.SALES_VOID,
  P.PAYMENTS_RECORD,
  P.CASH_CLOSE,
  P.CASH_EXPECTED_READ,
  P.DEBTORS_READ,
  P.DEBTORS_MANAGE,
  P.STOCK_READ,
  P.STOCK_RECEIVE,
  P.STOCK_COUNT,
  P.STOCK_TRANSFER,
  P.STOCK_ADJUST,
  P.PRODUCTS_MANAGE,
  P.PRICES_COST_READ,
  P.PURCHASES_MANAGE,
  P.MONEY_READ,
  P.EXPENSES_RECORD,
  P.REPORTS_SALES_READ,
  P.REPORTS_STOCK_READ,
  P.REPORTS_PROFIT_READ,
];

/**
 * What each job function may see and do. This is the reference the database grants are tested against
 * (role_permissions must match it exactly). Deny by default: anything not listed is refused.
 *
 * Separation of duties built in:
 * - Taking money (CASHIER) is separate from voiding sales and seeing the expected cash in the drawer (MANAGER).
 * - Receiving and counting stock (INVENTORY) is separate from adjusting stock and ordering from suppliers (MANAGER).
 * - Recording expenses (ACCOUNTANT, MANAGER) is separate from approving them (OWNER, ADMINISTRATOR).
 * - Checking the books (ACCOUNTANT, AUDITOR) comes without taking sales or payments.
 */
export const ROLE_PERMISSIONS: Record<RoleName, readonly PermissionCode[]> = {
  OWNER: [...base, ...settingsAll, ...runTheShop, P.EXPENSES_APPROVE, P.CUSTOMERS_EXPORT, P.AUDIT_READ],
  ADMINISTRATOR: [...base, ...settingsAll, ...runTheShop, P.EXPENSES_APPROVE, P.CUSTOMERS_EXPORT, P.AUDIT_READ],
  MANAGER: [
    ...base,
    P.USERS_READ,
    P.BRANCHES_MANAGE,
    P.BRANCH_SETTINGS_MANAGE,
    P.STAFF_MANAGE,
    P.DEVICES_MANAGE,
    ...runTheShop,
  ],
  ACCOUNTANT: [...base, ...readFigures, P.EXPENSES_RECORD],
  AUDITOR: [...base, ...readFigures, P.USERS_READ, P.AUDIT_READ],
  SALES: [
    ...base,
    P.CUSTOMERS_READ,
    P.CUSTOMERS_MANAGE,
    P.FOLLOWUPS_MANAGE,
    P.SALES_CREATE,
    P.SALES_READ_OWN,
    P.STOCK_READ,
  ],
  CASHIER: [
    ...base,
    P.CUSTOMERS_LOOKUP,
    P.SALES_CREATE,
    P.SALES_READ_OWN,
    P.PAYMENTS_RECORD,
    P.CASH_CLOSE,
    P.DEBTORS_READ,
    P.STOCK_READ,
  ],
  INVENTORY: [...base, P.STOCK_READ, P.STOCK_RECEIVE, P.STOCK_COUNT, P.STOCK_TRANSFER, P.REPORTS_STOCK_READ],
  EMPLOYEE: [...base],
};
