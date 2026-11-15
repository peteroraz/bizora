import { Permission } from "@bizora/contracts";

/** What the signed-in person may see. Comes from GET /api/v1/auth/me (tenant.permissions and tenant.deviceId). */
export type Access = {
  permissions: readonly string[];
  /** True when a shop staff member signed in with a PIN on an enrolled shop device. */
  staffSession: boolean;
};

export const noAccess: Access = { permissions: [], staffSession: false };

export function can(access: Access, ...anyOf: string[]) {
  return anyOf.some((permission) => access.permissions.includes(permission));
}

/**
 * Which permissions open each main menu item. Any one of them is enough; null means everyone.
 * Unknown items are hidden (deny by default). The server still checks every request.
 */
const moduleRules: Record<string, readonly string[] | null> = {
  home: null,
  settings: null,
  sales: [Permission.SALES_CREATE, Permission.SALES_READ_OWN, Permission.SALES_READ_ALL],
  stock: [Permission.STOCK_READ],
  customers: [Permission.CUSTOMERS_READ, Permission.CUSTOMERS_LOOKUP],
  debtors: [Permission.DEBTORS_READ],
  money: [Permission.MONEY_READ],
  staff: [Permission.STAFF_MANAGE, Permission.DEVICES_MANAGE],
  reports: [Permission.REPORTS_SALES_READ, Permission.REPORTS_STOCK_READ, Permission.REPORTS_PROFIT_READ],
};

/** The permissions that open a menu item, or null when everyone may open it. Throws for unknown items. */
export function moduleRule(id: string): readonly string[] | null {
  const rule = moduleRules[id];
  if (rule === undefined) throw new Error(`No access rule for menu item ${id}`);
  return rule;
}

/** Main menu items this person can open. */
export function navAllowed(access: Access, id: string) {
  const rule = moduleRules[id];
  if (rule === undefined) return false;
  return rule === null || can(access, ...rule);
}

/** How this person may use Customers: the full list, a counter lookup (cashier), or not at all. */
export function customerMode(access: Access): "list" | "lookup" | "none" {
  if (can(access, Permission.CUSTOMERS_READ)) return "list";
  if (can(access, Permission.CUSTOMERS_LOOKUP)) return "lookup";
  return "none";
}

export type HomeCard =
  | "sales"
  | "mySales"
  | "money"
  | "cash"
  | "debtors"
  | "stock"
  | "staff"
  | "approval"
  | "followups"
  | "findCustomer";

/** Home dashboard cards for this person's job. Each card needs the permission that shows its figures. */
export function homeCards(access: Access): HomeCard[] {
  const cards: HomeCard[] = [];
  if (can(access, Permission.SALES_READ_ALL)) cards.push("sales");
  else if (can(access, Permission.SALES_READ_OWN)) cards.push("mySales");
  if (can(access, Permission.MONEY_READ)) cards.push("money");
  // The expected cash in the drawer stays hidden from whoever counts it (blind count).
  if (can(access, Permission.CASH_EXPECTED_READ)) cards.push("cash");
  if (can(access, Permission.DEBTORS_READ)) cards.push("debtors");
  if (can(access, Permission.STOCK_READ)) cards.push("stock");
  if (can(access, Permission.STAFF_MANAGE)) cards.push("staff");
  if (can(access, Permission.SALES_VOID, Permission.STOCK_ADJUST, Permission.EXPENSES_APPROVE)) cards.push("approval");
  if (can(access, Permission.CUSTOMERS_READ)) cards.push("followups");
  else if (can(access, Permission.CUSTOMERS_LOOKUP)) cards.push("findCustomer");
  return cards;
}

export const settingsTabs = [
  "organization",
  "business",
  "shop",
  "branches",
  "team",
  "appearance",
  "security",
] as const;
export type SettingsTab = (typeof settingsTabs)[number];

/** Settings tabs this person can use. "appearance" (theme and language) is personal, so everyone gets it. */
export function visibleSettingsTabs(
  access: Access,
  staffFeatures: boolean,
): SettingsTab[] {
  return settingsTabs.filter((tab) => {
    switch (tab) {
      case "organization":
        return can(access, Permission.ORG_SETTINGS_MANAGE);
      case "business":
      case "shop":
        return can(access, Permission.BUSINESS_SETTINGS_MANAGE);
      case "branches":
        return can(
          access,
          Permission.BRANCH_SETTINGS_MANAGE,
          Permission.BRANCHES_MANAGE,
        );
      case "team":
        return staffFeatures && can(access, Permission.USERS_READ);
      case "appearance":
        return true;
      case "security":
        // PIN staff have no email, password or Google sign-in to manage.
        return !access.staffSession;
    }
  });
}
