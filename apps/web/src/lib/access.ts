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

/** Main menu items this person can open. The server still checks every request. */
export function navAllowed(access: Access, id: string) {
  switch (id) {
    case "customers":
      return can(access, Permission.CUSTOMERS_READ);
    case "staff":
      return can(access, Permission.STAFF_MANAGE, Permission.DEVICES_MANAGE);
    default:
      return true;
  }
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
