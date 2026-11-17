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

/** A calendar date (YYYY-MM-DD) the way traders read it: "17 Nov 2026". Never shifted by time zone. */
export function formatDay(isoDate: string, locale: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** Adds days to a calendar date (YYYY-MM-DD) without time-zone surprises. */
export function addDays(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

/** Nigerian numbers as people say them: +2348031234567 → 0803 123 4567. Other countries stay international. */
export function formatPhone(e164: string | null | undefined) {
  if (!e164) return "";
  const nigerian = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nigerian ? `0${nigerian[1]} ${nigerian[2]} ${nigerian[3]}` : e164;
}
