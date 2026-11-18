import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@bizora/contracts";
import { customerMode, homeCards, navAllowed, visibleSettingsTabs, type Access } from "./access";

const owner: Access = {
  staffSession: false,
  permissions: [
    "tenant.read",
    "customers.read",
    "customers.manage",
    "users.read",
    "users.invite",
    "staff.manage",
    "devices.manage",
    "org.settings.manage",
    "branding.manage",
    "business.settings.manage",
    "branch.settings.manage",
    "branches.manage",
  ],
};
const pinCashier: Access = {
  staffSession: true,
  permissions: ["tenant.read", "branches.read", "customers.read"],
};
const emailCashier: Access = { ...pinCashier, staffSession: false };
const storekeeper: Access = {
  staffSession: true,
  permissions: ["tenant.read", "branches.read"],
};

describe("settings tabs", () => {
  it("gives the owner every tab", () => {
    expect(visibleSettingsTabs(owner, true)).toEqual([
      "organization",
      "brand",
      "business",
      "shop",
      "branches",
      "team",
      "appearance",
      "security",
    ]);
    expect(visibleSettingsTabs(owner, false)).not.toContain("team");
  });

  it("gives a PIN cashier only theme and language", () => {
    expect(visibleSettingsTabs(pinCashier, true)).toEqual(["appearance"]);
  });

  it("lets a cashier with an email manage their own sign-in", () => {
    expect(visibleSettingsTabs(emailCashier, true)).toEqual([
      "appearance",
      "security",
    ]);
  });
});

describe("menu", () => {
  it("hides Staff from anyone who cannot manage staff or devices", () => {
    expect(navAllowed(owner, "staff")).toBe(true);
    expect(navAllowed(pinCashier, "staff")).toBe(false);
  });

  it("hides Customers from roles without customer access", () => {
    expect(navAllowed(pinCashier, "customers")).toBe(true);
    expect(navAllowed(storekeeper, "customers")).toBe(false);
    expect(navAllowed(storekeeper, "home")).toBe(true);
  });
});

describe("job functions (real ROLE_PERMISSIONS)", () => {
  const as = (role: keyof typeof ROLE_PERMISSIONS, staffSession = false): Access => ({
    permissions: ROLE_PERMISSIONS[role],
    staffSession,
  });
  const menu = (access: Access) =>
    ["home", "sales", "stock", "customers", "debtors", "suppliers", "money", "staff", "reports", "settings"].filter((id) => navAllowed(access, id));

  it("gives each role the menu for its job", () => {
    expect(menu(as("OWNER"))).toEqual(["home", "sales", "stock", "customers", "debtors", "suppliers", "money", "staff", "reports", "settings"]);
    expect(menu(as("MANAGER"))).toEqual(["home", "sales", "stock", "customers", "debtors", "suppliers", "money", "staff", "reports", "settings"]);
    // Cashiers open Money only to count the drawer (without seeing what is expected).
    expect(menu(as("CASHIER", true))).toEqual(["home", "sales", "stock", "customers", "debtors", "money", "settings"]);
    expect(menu(as("SALES", true))).toEqual(["home", "sales", "stock", "customers", "settings"]);
    expect(menu(as("INVENTORY", true))).toEqual(["home", "stock", "reports", "settings"]);
    expect(menu(as("ACCOUNTANT"))).toEqual(["home", "sales", "stock", "customers", "debtors", "suppliers", "money", "reports", "settings"]);
    expect(menu(as("EMPLOYEE", true))).toEqual(["home", "settings"]);
  });

  it("hides unknown menu items", () => {
    expect(navAllowed(as("OWNER"), "payroll")).toBe(false);
  });

  it("shows home cards that match the job", () => {
    expect(homeCards(as("OWNER"))).toEqual(["sales", "money", "cash", "debtors", "stock", "staff", "approval", "followups"]);
    // Cashier: own sales, who owes, stock, and counter lookup. No cash flow, no expected cash (blind count).
    expect(homeCards(as("CASHIER", true))).toEqual(["mySales", "debtors", "stock", "findCustomer"]);
    // Sales staff: own sales, stock, own follow-ups. No money or debtors.
    expect(homeCards(as("SALES", true))).toEqual(["mySales", "stock", "followups"]);
    expect(homeCards(as("INVENTORY", true))).toEqual(["stock"]);
    // Desk flow: the cashier and store keeper see their waiting lists first, and the store keeper gets Sales.
    expect(homeCards({ ...as("CASHIER", true), salesFlow: "desk" })).toEqual(["toCollect", "mySales", "debtors", "stock", "findCustomer"]);
    expect(homeCards({ ...as("INVENTORY", true), salesFlow: "desk" })).toEqual(["toRelease", "stock"]);
    expect(navAllowed({ ...as("INVENTORY", true), salesFlow: "desk" }, "sales")).toBe(true);
    expect(navAllowed(as("INVENTORY", true), "sales")).toBe(false);
    expect(homeCards(as("ACCOUNTANT"))).toEqual(["sales", "money", "cash", "debtors", "stock", "followups"]);
    expect(homeCards(as("EMPLOYEE", true))).toEqual([]);
  });

  it("gives a cashier counter lookup, and a storekeeper no customers", () => {
    expect(customerMode(as("CASHIER", true))).toBe("lookup");
    expect(customerMode(as("SALES", true))).toBe("list");
    expect(customerMode(as("INVENTORY", true))).toBe("none");
    expect(customerMode(as("EMPLOYEE", true))).toBe("none");
  });

  it("gives a manager only shop and staff settings", () => {
    expect(visibleSettingsTabs(as("MANAGER"), true)).toEqual(["branches", "team", "appearance", "security"]);
    expect(visibleSettingsTabs(as("ACCOUNTANT"), true)).toEqual(["appearance", "security"]);
  });
});
