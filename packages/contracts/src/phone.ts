import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export function normalizePhoneToE164(input: string, countryCode: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const country = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, country as CountryCode);
    if (!parsed?.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

export function whatsAppHref(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  const query = text.trim().length > 0 ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
}
