export const primaryNav = [
  { id: "home", href: "/app", icon: "home", enabled: true },
  { id: "sales", href: "/app/sales", icon: "sales", enabled: true },
  { id: "stock", href: "/app/stock", icon: "stock", enabled: true },
  { id: "customers", href: "/app/customers", icon: "customers", enabled: true },
  { id: "debtors", href: "/app/debtors", icon: "debtors", enabled: true },
  { id: "money", href: "/app/money", icon: "money", enabled: false },
  { id: "staff", href: "/app/staff", icon: "staff", enabled: true },
  { id: "reports", href: "/app/reports", icon: "reports", enabled: false },
  { id: "settings", href: "/app/settings", icon: "settings", enabled: true },
] as const;

export const bottomNav = ["home", "sales", "customers", "debtors"] as const;

export const comingSoonModules = {
  money: "money",
  reports: "reports",
} as const;

export type NavId = (typeof primaryNav)[number]["id"];
