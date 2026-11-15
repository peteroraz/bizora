import { formatMoney } from "@bizora/money/format";

export function formatCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

export function dayKey(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export function formatWhen(value: string | Date, locale: string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

export function formatCurrency(amountMinor: bigint, currency: string, locale: string) {
  return formatMoney(amountMinor, currency, locale);
}
