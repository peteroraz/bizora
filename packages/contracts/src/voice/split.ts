import { ENGLISH, type VoiceLexicon } from "./lexicon.js";

/**
 * Several sales said or typed in one go (ADR-057): "Emeka bought 2 bags of rice, paid cash. Next customer: 3 cups of
 * ogiri 1,500 for all." Each part is read on its own as one sale, and each is confirmed on its own; nothing is joined.
 *
 * A new sale starts only at a clear marker, never at a guess:
 * - a marker phrase: "next customer", "another customer", "second customer", "next sale", "another sale", "new sale",
 *   "sale two", "customer 2"…;
 * - a numbered list: lines starting "1." / "2)" / "2 -";
 * - a blank line between two parts;
 * - a sentence that starts with a name and a buying word ("Chidi took…", "Mama Ngozi bought…") once the current part
 *   already has something sold in it.
 * "New customer" is not a marker: it says the buyer is not in the list yet.
 */
const ORDINALS = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "last"];
const NUMBERS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

function markerPattern() {
  const people = ["customer", "buyer", "person", "sale", "one"];
  const lead = ["next", "another", ...ORDINALS];
  const phrases = [
    ...lead.flatMap((word) => people.map((who) => `${word}\\s+${who}`)),
    "new\\s+sale",
    ...["sale", "customer"].flatMap((who) => NUMBERS.map((number) => `${who}\\s+(?:number\\s+)?${number}`)),
  ];
  // The marker with what may follow it (": - ,"), at a word boundary.
  return new RegExp(`(?:^|[\\s.,;!?])(?:and\\s+|then\\s+|the\\s+)?(?:${phrases.join("|")})\\b\\s*[:,\\-–—.]?`, "gi");
}

const MARKER = markerPattern();
const NUMBERED_LINE = /^\s*(\d{1,2})\s*[.)\-:]\s+/;

/** A quantity or an amount in the text: a digit, or a number word. */
function hasSomethingSold(text: string, lexicon: VoiceLexicon) {
  if (/\d/.test(text)) return true;
  const words = text.toLowerCase().split(/[^a-z']+/);
  return words.some((word) => word in lexicon.units || word in lexicon.tens || word in lexicon.scales);
}

function bySentenceBuyer(text: string, lexicon: VoiceLexicon) {
  const verbs = lexicon.customerVerbs.filter((verb) => !verb.includes(" ")).join("|");
  const titles = lexicon.honorifics.join("|");
  // A sentence break, then a name (an optional title and one or two capitalised words), then a buying word.
  const start = new RegExp(`(?<=[.!?;]\\s+|\\n\\s*)(?=(?:(?:${titles})\\.?\\s+)?[A-Z][\\p{L}'-]+(?:\\s+[A-Z][\\p{L}'-]+)?\\s+(?:${verbs})\\b)`, "giu");
  const parts: string[] = [];
  let from = 0;
  for (const match of text.matchAll(start)) {
    const at = match.index ?? 0;
    const before = text.slice(from, at);
    if (hasSomethingSold(before, lexicon)) {
      parts.push(before);
      from = at;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** Splits text into one text per sale. One sale gives a list of one. Empty parts are dropped. */
export function splitSpokenSales(text: string, lexicon: VoiceLexicon = ENGLISH): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  let parts: string[] = [clean];

  // A numbered list: "1. … 2. …", each number at the start of a line.
  const lines = clean.split("\n");
  if (lines.filter((line) => NUMBERED_LINE.test(line)).length >= 2) {
    const numbered: string[] = [];
    for (const line of lines) {
      if (NUMBERED_LINE.test(line) || numbered.length === 0) numbered.push(line.replace(NUMBERED_LINE, ""));
      else numbered[numbered.length - 1] += `\n${line}`;
    }
    parts = numbered;
  }

  // Blank lines between parts.
  parts = parts.flatMap((part) => part.split(/\n\s*\n/));
  // Marker phrases.
  parts = parts.flatMap((part) => part.split(MARKER));
  // A new buyer's sentence once something was sold.
  parts = parts.flatMap((part) => bySentenceBuyer(part, lexicon));

  return parts.map((part) => part.replace(/^[\s,.;:\-–—]+|[\s,;:\-–—]+$/g, "").trim()).filter((part) => part.length > 0 && hasSomethingSold(part, lexicon));
}

/**
 * Text typed in the product search box that is really a sale ("20 bags of rice 750k for all, 3 cups of ogiri…"),
 * so the screen can offer to read it as a sale instead of making it one item's name.
 */
export function looksLikeSpokenSale(text: string, lexicon: VoiceLexicon = ENGLISH): boolean {
  const clean = text.trim();
  if (clean.length < 20) return false;
  const numbers = clean.match(/\d[\d,.]*\s*(?:k|m)?\b/gi) ?? [];
  if (numbers.length >= 2) return true;
  const words = clean.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const said = words.filter((word) => word in lexicon.units || word in lexicon.tens || word in lexicon.scales).length + numbers.length;
  const marketWord = words.some((word) => lexicon.unit(word) !== null || lexicon.paid.includes(word) || word in lexicon.methods);
  return said >= 2 || (said >= 1 && marketWord && clean.length > 30);
}
