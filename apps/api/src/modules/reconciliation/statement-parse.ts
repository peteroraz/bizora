import { createHash } from "node:crypto";
import { parseMoneyInput, parseTraderDate } from "@bizora/contracts";

/**
 * Reads one amount from a statement cell: "₦4,500.00", "4,500.00 CR", "(4,500.00)" or "-4500" (negative means the
 * other direction). Returns kobo, signed, or null when unreadable; 0n for an empty cell.
 */
export function statementAmount(text: string, digits = 2): bigint | null {
  let value = text.trim().toUpperCase().replace(/NGN/g, "");
  if (!value || value === "-" || value === "0" || value === "0.00") return 0n;
  let sign = 1n;
  if (/^\(.*\)$/.test(value)) {
    sign = -1n;
    value = value.slice(1, -1);
  }
  if (value.startsWith("-")) {
    sign = -sign;
    value = value.slice(1);
  }
  if (value.endsWith("DR")) {
    sign = -sign;
    value = value.slice(0, -2);
  }
  value = value.replace(/CR$/, "").trim();
  const minor = parseMoneyInput(value, digits);
  return minor === null ? null : sign * minor;
}

export type ParsedStatementRow =
  | { kind: "in"; date: string; description: string; reference: string | null; amount: bigint }
  | { kind: "out" }
  | { kind: "empty" }
  | { kind: "error"; errors: { field: string; message: string }[] };

export function parseStatementRow(row: { date: string; description: string; reference: string; moneyIn: string; moneyOut: string }, digits = 2): ParsedStatementRow {
  const errors: { field: string; message: string }[] = [];
  const moneyIn = statementAmount(row.moneyIn, digits);
  const moneyOut = statementAmount(row.moneyOut, digits);
  if (moneyIn === null) errors.push({ field: "moneyIn", message: `Can't read the amount "${row.moneyIn}".` });
  if (moneyOut === null) errors.push({ field: "moneyOut", message: `Can't read the amount "${row.moneyOut}".` });
  if (errors.length > 0) return { kind: "error", errors };
  const amountIn = (moneyIn ?? 0n) > 0n ? (moneyIn as bigint) : 0n;
  const isOut = (moneyOut ?? 0n) !== 0n || (moneyIn ?? 0n) < 0n;
  if (amountIn === 0n) return isOut ? { kind: "out" } : { kind: "empty" };
  const date = parseTraderDate(row.date);
  if (!date) return { kind: "error", errors: [{ field: "date", message: row.date.trim() ? `Can't read the date "${row.date}".` : "Enter the date." }] };
  return { kind: "in", date, description: row.description.trim().replace(/\s+/g, " ").slice(0, 300), reference: row.reference.trim().slice(0, 120) || null, amount: amountIn };
}

/** The same line in two overlapping statements gets the same fingerprint; identical lines on one day are counted. */
export function fingerprint(businessId: string, line: { date: string; description: string; reference: string | null; amount: bigint }, occurrence: number) {
  const text = [businessId, line.date, line.amount.toString(), normalizeText(line.description), normalizeText(line.reference ?? ""), String(occurrence)].join("|");
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeText(text: string) {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

const NOISE = new Set(["TRF", "TRANSFER", "FRM", "FROM", "NIP", "INWARD", "OUTWARD", "PAYMENT", "PYMT", "FOR", "THE", "AND", "MOB", "WEB", "USSD", "GTB", "UBA", "ZENITH", "ACCESS", "FIRST", "BANK", "OPAY", "PALMPAY", "MONIEPOINT", "KUDA"]);

/** How well a customer's name appears in a statement narration: share of the name's words found, 0 to 1. */
export function nameScore(customerName: string, description: string) {
  const words = normalizeText(customerName)
    .split(" ")
    .filter((word) => word.length >= 3 && !NOISE.has(word));
  if (words.length === 0) return 0;
  const haystack = new Set(normalizeText(description).split(" "));
  return words.filter((word) => haystack.has(word)).length / words.length;
}

/** A recorded payment's reference counts as an exact match when it appears in the statement line. */
export function referenceMatches(paymentReference: string | null, line: { description: string; reference: string | null }) {
  const reference = normalizeText(paymentReference ?? "").replace(/ /g, "");
  if (reference.length < 4) return false;
  return normalizeText(`${line.reference ?? ""} ${line.description}`).replace(/ /g, "").includes(reference);
}
