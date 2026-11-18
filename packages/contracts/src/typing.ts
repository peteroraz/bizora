/**
 * What may be typed into a box, and how it reads while typing (ADR-027). Shared by the screens (as people type)
 * and the API (as the final check), so both agree. No dependencies: safe for every screen's JavaScript budget.
 *
 * Numbers use "." for decimals and "," between thousands, the way English screens show money today. Other ways of
 * writing numbers come with translations (Sprint 3D).
 */

/** Decimal places a currency uses: NGN, GHS, KES, EUR 2; XOF, JPY, UGX 0; KWD, BHD 3. Same source as formatMoney. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.trim().toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Keeps only what a number may hold while typing and puts in the commas: "1500.5" → "1,500.5", "12a3" → "123",
 * "1.2.3" → "1.23". `decimals` 0 allows whole numbers only. A leading "." becomes "0.".
 */
export function typeNumber(raw: string, decimals: number, maxWholeDigits = 13): string {
  const text = raw.replace(/[^\d.]/g, "");
  const dot = decimals > 0 ? text.indexOf(".") : -1;
  const whole = (dot >= 0 ? text.slice(0, dot) : text.replace(/\./g, "")).replace(/^0+(?=\d)/, "").slice(0, maxWholeDigits);
  if (dot < 0) return group(whole);
  const fraction = text.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  return `${group(whole || "0")}.${fraction}`;
}

/** Same as typeNumber with the decimals of the currency. */
export function typeAmount(raw: string, currency: string) {
  return typeNumber(raw, currencyDigits(currency));
}

/** "1,500.50" → 150050n with 2 decimals. Commas, spaces and currency signs are ignored. Null when not a valid amount. */
export function parseAmountDigits(text: string, digits: number): bigint | null {
  const value = text.trim().replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const pattern = digits > 0 ? new RegExp(`^(\\d{1,15})(?:\\.(\\d{0,${digits}}))?$`) : /^(\d{1,15})$/;
  const match = pattern.exec(value);
  if (!match) return null;
  return BigInt(match[1] ?? "0") * 10n ** BigInt(digits) + BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
}

/** A typed amount in the currency's smallest unit (kobo, pesewa, cent; whole francs for XOF). Null when invalid. */
export function parseAmount(text: string, currency: string): bigint | null {
  return parseAmountDigits(text, currencyDigits(currency));
}

/** 150050n → "1,500.50"; 150000n → "1,500". For putting a saved amount back into a box. */
export function amountText(minor: bigint, currency: string): string {
  const digits = currencyDigits(currency);
  const scale = 10n ** BigInt(digits);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const fraction = absolute % scale;
  const whole = group((absolute / scale).toString());
  return `${negative ? "-" : ""}${whole}${fraction === 0n ? "" : `.${fraction.toString().padStart(digits, "0")}`}`;
}

/**
 * Capitalises the first letter of every word as someone types a person's or business's name: "ada okafor-bello"
 * → "Ada Okafor-Bello". Other letters are left as typed, so "McDonald" and "DHL" stay as they are; "mama's" keeps
 * its "s". Works for any alphabet that has capitals.
 */
export function capitaliseWords(text: string) {
  return text.replace(/(^|[\s\-(/])(\p{Ll})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase()}`);
}

/** First letter only, for product names and notes: "indomie chicken 70g" → "Indomie chicken 70g". */
export function capitaliseFirst(text: string) {
  return text.replace(/^(\s*)(\p{Ll})/u, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase()}`);
}

/**
 * The finished name, when the box is left: spaces tidied, first letters capitalised, and a name typed all in
 * capitals ("ADA OKAFOR") written normally. Short all-capital words in a longer name (DHL, UBA) stay.
 */
export function tidyName(text: string) {
  const spaced = text.replace(/\s+/g, " ").trim();
  const letters = spaced.replace(/[^\p{L}]/gu, "");
  const shouting = letters.length > 3 && letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase();
  return capitaliseWords(shouting ? spaced.toLocaleLowerCase() : spaced);
}

/** An email as it should be saved: no spaces, lower case. */
export function tidyEmail(text: string) {
  return text.replace(/\s+/g, "").toLowerCase();
}

/** Digits only, at most `max`: PINs, codes, counts. */
export function typeDigits(raw: string, max: number) {
  return raw.replace(/\D/g, "").slice(0, max);
}

/**
 * Where the caret should go after a box reformats what was typed: after the same number of digits (and dot) as
 * before it. Typing "5" in "1,00|0" gives "10,00|5"-style jumps otherwise.
 */
export function caretAfterFormat(before: string, caret: number, after: string) {
  const significant = before.slice(0, caret).replace(/[^\d.]/g, "").length;
  if (significant === 0) return 0;
  let seen = 0;
  for (let index = 0; index < after.length; index += 1) {
    if (/[\d.]/.test(after[index] ?? "")) seen += 1;
    if (seen === significant) return index + 1;
  }
  return after.length;
}
