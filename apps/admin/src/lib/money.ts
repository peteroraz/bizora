import { formatMoney } from "@bizora/money";

/** An amount in minor units as the business's currency, e.g. ₦12,500.00. */
export function amount(minor: string | number | bigint | null | undefined, currency: string) {
  if (minor === null || minor === undefined) return "";
  try {
    return formatMoney(BigInt(minor), currency, "en-GB");
  } catch {
    return String(minor);
  }
}
