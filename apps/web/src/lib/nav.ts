export const primaryNav = [
  { href: "/app", label: "Home", icon: "home", enabled: true },
  { href: "/app/sales", label: "Sales", icon: "sales", enabled: false },
  { href: "/app/customers", label: "Customers", icon: "customers", enabled: false },
  { href: "/app/products", label: "Products", icon: "products", enabled: false },
  { href: "/app/purchasing", label: "Purchasing", icon: "purchasing", enabled: false },
  { href: "/app/expenses", label: "Expenses", icon: "expenses", enabled: false },
  { href: "/app/reports", label: "Reports", icon: "reports", enabled: false },
  { href: "/app/inbox", label: "Inbox", icon: "inbox", enabled: false },
  { href: "/app/ai", label: "AI", icon: "ai", enabled: false },
  { href: "/app/settings", label: "Settings", icon: "settings", enabled: true },
] as const;

export const comingSoonModules = {
  sales: "Sales",
  customers: "Customers",
  products: "Products",
  purchasing: "Purchasing",
  expenses: "Expenses",
  reports: "Reports",
  inbox: "Inbox",
  ai: "AI",
} as const;
