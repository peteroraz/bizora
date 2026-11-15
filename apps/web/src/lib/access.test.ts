import { describe, expect, it } from "vitest";
import { navAllowed, visibleSettingsTabs, type Access } from "./access";

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
