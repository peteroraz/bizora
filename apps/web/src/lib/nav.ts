export const primaryNav = [
  { id: "home", href: "/app", icon: "home", enabled: true },
  { id: "sales", href: "/app/sales", icon: "sales", enabled: true },
  { id: "stock", href: "/app/stock", icon: "stock", enabled: true },
  { id: "customers", href: "/app/customers", icon: "customers", enabled: true },
  { id: "debtors", href: "/app/debtors", icon: "debtors", enabled: true },
  { id: "money", href: "/app/money", icon: "money", enabled: true },
  { id: "staff", href: "/app/staff", icon: "staff", enabled: true },
  { id: "reports", href: "/app/reports", icon: "reports", enabled: false },
  { id: "settings", href: "/app/settings", icon: "settings", enabled: true },
] as const;

/** Kept for screens that only need to know the default order. */
export const bottomNav = ["home", "sales", "stock", "debtors"] as const;

/**
 * The bottom bar holds each person's main jobs (at most four); the rest go under More.
 * Store keepers get Stock, cashiers get Debtors, accountants get Money.
 */
const BOTTOM_BY_ROLE: Record<string, readonly NavId[]> = {
  OWNER: ["home", "sales", "stock", "debtors", "customers"],
  ADMINISTRATOR: ["home", "sales", "stock", "debtors", "customers"],
  MANAGER: ["home", "sales", "stock", "debtors", "customers"],
  CASHIER: ["home", "sales", "debtors", "customers", "stock"],
  INVENTORY: ["home", "stock", "sales", "customers"],
  SALES: ["home", "sales", "customers", "stock"],
  ACCOUNTANT: ["home", "money", "debtors", "sales", "stock"],
  AUDITOR: ["home", "sales", "money", "stock"],
};
const BOTTOM_DEFAULT: readonly NavId[] = ["home", "sales", "stock", "debtors", "customers"];

export function bottomItemsFor<T extends { id: NavId }>(role: string | null | undefined, items: readonly T[]) {
  const order = BOTTOM_BY_ROLE[role ?? ""] ?? BOTTOM_DEFAULT;
  const allowed = new Map(items.map((item) => [item.id, item]));
  const bottom = order.filter((id) => allowed.has(id)).slice(0, 4).map((id) => allowed.get(id) as T);
  const chosen = new Set(bottom.map((item) => item.id));
  return { bottom, more: items.filter((item) => !chosen.has(item.id)) };
}

export const comingSoonModules = {
  reports: "reports",
} as const;

export type NavId = (typeof primaryNav)[number]["id"];
