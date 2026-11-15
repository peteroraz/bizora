/**
 * Formatting only, with no decimal maths library, so web pages that just show amounts stay small.
 * Import from "@bizora/money/format" in the browser.
 */
const ISO_4217 = /^[A-Z]{3}$/;

function assertCurrency(code: string): string {
  const normalized = code.toUpperCase();
  if (!ISO_4217.test(normalized)) {
    throw new Error(`Invalid ISO 4217 currency code: ${code}`);
  }
  return normalized;
}

function groupDigits(whole: string, separator: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

export function formatMoney(amountMinor: bigint, currencyCode: string, locale = "en"): string {
  if (typeof amountMinor !== "bigint") {
    throw new Error("Money amounts must use bigint minor units, never floating point");
  }
  const currency = assertCurrency(currencyCode);
  const options: Intl.NumberFormatOptions = { style: "currency", currency, currencyDisplay: "narrowSymbol" };
  const digits = new Intl.NumberFormat(locale, options).resolvedOptions().maximumFractionDigits ?? 2;
  const template = new Intl.NumberFormat(locale, options).formatToParts(0);
  const group =
    new Intl.NumberFormat(locale, options).formatToParts(1000).find((part) => part.type === "group")?.value ?? ",";
  const scale = 10n ** BigInt(digits);
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const whole = groupDigits((absolute / scale).toString(), group);
  const fraction = (absolute % scale).toString().padStart(digits, "0");
  const rendered = template
    .map((part) => {
      if (part.type === "integer") return whole;
      if (part.type === "fraction") return fraction;
      if (part.type === "group") return "";
      return part.value;
    })
    .join("");
  return negative ? `-${rendered}` : rendered;
}

