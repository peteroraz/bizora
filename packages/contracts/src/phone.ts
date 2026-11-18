import {
  AsYouType,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";

/**
 * Phone numbers checked against the country's own rules: which digits a number starts with and how long it is
 * (full "max" rules, not only the length, ADR-027). Screens load this file only when a phone box is used, so it
 * does not weigh on the quick sale screen. Import from "@bizora/contracts/phone" in the browser.
 */

export { whatsAppHref } from "./whatsapp.js";

export type PhoneProblem = "too_short" | "too_long" | "invalid";

export type PhoneCheck =
  | { ok: true; e164: string; country: string | null; national: string; international: string }
  | { ok: false; problem: PhoneProblem; country: string | null };

function countryOf(code: string | null | undefined): CountryCode | null {
  const country = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  try {
    getCountryCallingCode(country as CountryCode);
    return country as CountryCode;
  } catch {
    return null;
  }
}

/** The country a typed number belongs to: its +code when it has one, otherwise the business's country. */
function typedCountry(text: string, fallback: CountryCode | null): string | null {
  if (!text.startsWith("+")) return fallback;
  const typer = new AsYouType();
  typer.input(text);
  return typer.getCountry() ?? null;
}

/**
 * A number that is not valid but has an allowed length (Nigeria has fixed lines of several lengths): compared with
 * the country's mobile numbers, which is what customers nearly always give, so the message can say "too long".
 */
function lengthAgainstMobile(nationalNumber: string | undefined, country: string | null): PhoneProblem {
  const sample = countryOf(country) ? getExampleNumber(country as CountryCode, examples)?.nationalNumber : undefined;
  if (!nationalNumber || !sample) return "invalid";
  if (nationalNumber.length > sample.length) return "too_long";
  if (nationalNumber.length < sample.length) return "too_short";
  return "invalid";
}

/**
 * Checks a typed number for a business in `countryCode`. A local number ("0803 123 4567") is read as that
 * country's; one starting with "+" or "00" may be from anywhere ("+233 24 123 4567"). Null when nothing was typed.
 */
export function checkPhone(input: string, countryCode: string): PhoneCheck | null {
  const text = input.trim().replace(/^00(?=\d)/, "+");
  if (!text) return null;
  const fallback = countryOf(countryCode);
  if (!/\d/.test(text) || (!fallback && !text.startsWith("+"))) return { ok: false, problem: "invalid", country: fallback };
  const country = typedCountry(text, fallback);
  const length = validatePhoneNumberLength(text, fallback ?? undefined);
  if (length === "TOO_SHORT" || length === "NOT_A_NUMBER") return { ok: false, problem: "too_short", country };
  if (length === "TOO_LONG") return { ok: false, problem: "too_long", country };
  const parsed = parsePhoneNumberFromString(text, fallback ?? undefined);
  if (!parsed?.isValid()) return { ok: false, problem: lengthAgainstMobile(parsed?.nationalNumber, country), country };
  return {
    ok: true,
    e164: parsed.number,
    country: parsed.country ?? country,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
  };
}

/** The number in E.164 ("+2348031234567"), or null when it is not a valid number. */
export function normalizePhoneToE164(input: string, countryCode: string): string | null {
  const result = checkPhone(input, countryCode);
  return result?.ok ? result.e164 : null;
}

/** Spaces put in as the number is typed, the way the country writes it: "08031234567" → "0803 123 4567". */
export function typePhone(raw: string, countryCode: string): string {
  const text = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (!text) return "";
  return new AsYouType(countryOf(countryCode) ?? undefined).input(text);
}

/** A sample mobile number for the country, as people there write it: "0802 123 4567" in Nigeria. */
export function phoneExample(countryCode: string | null): string | null {
  const country = countryOf(countryCode);
  return country ? (getExampleNumber(country, examples)?.formatNational() ?? null) : null;
}

/** "+234" for NG. */
export function dialCode(countryCode: string | null): string | null {
  const country = countryOf(countryCode);
  return country ? `+${getCountryCallingCode(country)}` : null;
}

/** "Nigeria" for NG, in English. */
export function countryName(countryCode: string | null): string | null {
  if (!countryCode) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/** The plain message for a problem, in English (the API's errors; screens use their own messages). */
export function phoneProblemMessage(problem: PhoneProblem, country: string | null) {
  const name = countryName(country);
  const example = phoneExample(country);
  const where = name ? ` for ${name}` : "";
  const hint = example ? ` Numbers there look like ${example}.` : "";
  if (problem === "too_short") return `This number is too short${where}.${hint}`;
  if (problem === "too_long") return `This number is too long${where}.${hint}`;
  return name ? `This is not a valid ${name} number.${hint}` : "Enter a valid phone number.";
}
