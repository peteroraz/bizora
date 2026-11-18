"use client";

/**
 * Typing boxes that only take what fits, and write it the way people read it (ADR-027). Each is the plain Input
 * with a format (as you type) and a finish (when you leave the box), so controlled and uncontrolled forms both
 * work. Phone numbers are in phone-input.tsx, which loads its country rules only when it is used.
 */
import { capitaliseFirst, capitaliseWords, currencyDigits, tidyEmail, tidyName, typeAmount, typeDigits, typeNumber } from "@bizora/contracts";
import { Input, type InputProps } from "@bizora/ui";

type BoxProps = Omit<InputProps, "format" | "finish" | "type">;

/** "1,500.5" → "1,500.50" with 2 decimals; a dot left at the end goes. */
export function finishAmount(text: string, digits: number) {
  const trimmed = text.replace(/\.$/, "");
  if (!trimmed || digits === 0 || !trimmed.includes(".")) return trimmed;
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(digits, "0")}`;
}

/** "₦" for NGN, "GH₵" for GHS, "F CFA" for XOF: the sign shown inside amount boxes. */
export function currencySign(currency: string, locale = "en") {
  try {
    return (
      new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/**
 * Money in the business's currency: digits, one dot, the currency's decimals, commas between thousands. The
 * currency's sign sits inside the box, so labels need not name a currency.
 */
export function AmountInput({ currency, className, ...props }: BoxProps & { currency: string }) {
  const digits = currencyDigits(currency);
  const sign = currencySign(currency);
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted" aria-hidden="true">
        {sign}
      </span>
      <Input
        inputMode={digits > 0 ? "decimal" : "numeric"}
        autoComplete="off"
        className={className}
        style={{ paddingLeft: `${1.25 + sign.length * 0.55}rem` }}
        format={(text) => typeAmount(text, currency)}
        finish={(text) => finishAmount(text, digits)}
        {...props}
      />
    </div>
  );
}

/** Quantities: up to 3 decimals (2.5 kg, 0.75 m), commas between thousands. */
export function QuantityInput(props: BoxProps) {
  return <Input inputMode="decimal" autoComplete="off" format={(text) => typeNumber(text, 3)} finish={(text) => text.replace(/\.$/, "")} {...props} />;
}

/** Whole numbers only: counts of shops, staff, days. */
export function WholeNumberInput(props: BoxProps) {
  return <Input inputMode="numeric" autoComplete="off" format={(text) => typeNumber(text, 0)} {...props} />;
}

/** Digits only, up to `maxDigits`: PINs and codes. */
export function DigitsInput({ maxDigits, ...props }: BoxProps & { maxDigits: number; type?: "password" | "text" }) {
  return <Input inputMode="numeric" autoComplete="off" format={(text) => typeDigits(text, maxDigits)} {...props} />;
}

/** A person's or business's name: first letters capitalised as typed, tidied when left (ADA OKAFOR → Ada Okafor). */
export function NameInput(props: BoxProps) {
  return <Input autoCapitalize="words" spellCheck={false} format={capitaliseWords} finish={tidyName} {...props} />;
}

/** A product, category or shop name, or a short note: first letter capitalised, the rest as typed. */
export function SentenceInput(props: BoxProps) {
  return (
    <Input
      autoCapitalize="sentences"
      format={capitaliseFirst}
      finish={(text) => capitaliseFirst(text.replace(/\s+/g, " ").trim())}
      {...props}
    />
  );
}

/** An email address: no spaces, small letters. */
export function EmailInput(props: BoxProps) {
  return <Input type="email" inputMode="email" autoCapitalize="none" spellCheck={false} format={tidyEmail} {...props} />;
}
