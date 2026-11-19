import { z } from "zod";

/** What the trader sells. The trade types (6d) let Bizora switch on what each trade needs later: expiry for pharmacies, sizes for fashion. */
export const businessTypeSchema = z.enum([
  "shop",
  "market-stall",
  "wholesale",
  "pharmacy",
  "fashion",
  "electronics",
  "building",
  "food",
  "services",
  "other",
]);
export type BusinessType = z.infer<typeof businessTypeSchema>;

export const staffCountBandSchema = z.enum(["1", "2-5", "6-20", "21+"]);
export type StaffCountBand = z.infer<typeof staffCountBandSchema>;

export const traderModuleSchema = z.enum([
  "home",
  "sales",
  "jobs",
  "stock",
  "customers",
  "debtors",
  "money",
  "staff",
  "reports",
  "settings",
]);
export type TraderModule = z.infer<typeof traderModuleSchema>;

export const TRADER_MODULES: TraderModule[] = [
  "home",
  "sales",
  "jobs",
  "stock",
  "customers",
  "debtors",
  "money",
  "staff",
  "reports",
  "settings",
];

export const ALWAYS_VISIBLE_MODULES: TraderModule[] = ["home", "customers", "settings"];

export function industryForBusinessType(type: BusinessType): string {
  switch (type) {
    case "wholesale":
      return "wholesale";
    case "food":
      return "hospitality";
    case "services":
      return "professional-services";
    default:
      return "general-retail";
  }
}

export function businessTypeFromIndustry(code: string | null | undefined): BusinessType {
  switch (code) {
    case "wholesale":
      return "wholesale";
    case "hospitality":
      return "food";
    case "professional-services":
    case "healthcare-clinic":
      return "services";
    default:
      return "shop";
  }
}

export function deriveTraderSetup(input: {
  businessType?: string | null;
  staffCountBand?: string | null;
  otherCurrencies?: boolean | null;
  staffFeaturesEnabled?: boolean | null;
  multiCurrencyEnabled?: boolean | null;
  visibleModules?: readonly string[] | null;
}) {
  const staffFeatures =
    input.staffFeaturesEnabled ?? (input.staffCountBand ? input.staffCountBand !== "1" : true);
  const multiCurrency = input.multiCurrencyEnabled ?? Boolean(input.otherCurrencies);
  const requested = input.visibleModules ? new Set(input.visibleModules) : null;
  const modules = TRADER_MODULES.filter((module) => {
    if (ALWAYS_VISIBLE_MODULES.includes(module)) return true;
    if (requested) return requested.has(module);
    if (module === "stock" && input.businessType === "services") return false;
    // Jobs (ADR-035) are for work done for customers; other businesses can turn them on in settings.
    if (module === "jobs" && input.businessType !== "services") return false;
    if (module === "staff" && !staffFeatures) return false;
    return true;
  });
  return { staffFeatures, multiCurrency, modules };
}
