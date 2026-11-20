import type { VoiceLexicon } from "./lexicon.js";

/**
 * Spoken sales as tokens (ADR-040). Numbers become exact thousandths (no floating point): "seventy-five thousand" →
 * 75_000_000n, "2.5" → 2_500n, "75k" → 75_000_000n.
 */
export type NumberToken = {
  kind: "num";
  /** Thousandths: 1 is 1000n. */
  value: bigint;
  /** Said or written like money: "₦5,000", "75k", "five thousand naira". */
  moneyHint: boolean;
  /** A currency the speaker named, if any ("dollars" → USD). */
  currency: string | null;
  /** Said in the smallest coin ("fifty kobo"). */
  minor: boolean;
  raw: string;
  start: number;
  end: number;
};
export type WordToken = { kind: "word"; text: string; raw: string };
export type PunctToken = { kind: "punct"; text: string };
export type Token = NumberToken | WordToken | PunctToken;

const SCALE = 1000n;

/** Splits words, numbers and punctuation. Keeps the speaker's capitals in `raw` for names. */
export function rawTokens(text: string): (WordToken | PunctToken | { kind: "digits"; raw: string; value: bigint; suffix: string; symbol: string | null })[] {
  const out: (WordToken | PunctToken | { kind: "digits"; raw: string; value: bigint; suffix: string; symbol: string | null })[] = [];
  const pattern = /([₦#$£€₵])?\s?(\d+(?:,\d{3})*(?:\.\d+)?)\s?(k|m|b|bn)?(?![a-z])|(\bN)(?=\d)|([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’]*(?:\.[A-Za-z]\.?)*)|([.,;!?:@=+&/]|\s-\s)/giu;
  let match: RegExpExecArray | null;
  let pendingSymbol: string | null = null;
  while ((match = pattern.exec(text))) {
    if (match[2]) {
      const [whole, fraction = ""] = match[2].replace(/,/g, "").split(".");
      const digits = fraction.slice(0, 3).padEnd(3, "0");
      let value = BigInt(whole ?? "0") * SCALE + BigInt(digits);
      const suffix = (match[3] ?? "").toLowerCase();
      if (suffix === "k") value *= 1000n;
      if (suffix === "m") value *= 1_000_000n;
      if (suffix === "b" || suffix === "bn") value *= 1_000_000_000n;
      out.push({ kind: "digits", raw: match[0].trim(), value, suffix, symbol: match[1] ?? pendingSymbol });
      pendingSymbol = null;
    } else if (match[4]) {
      pendingSymbol = "n";
    } else if (match[5]) {
      const raw = match[5].replace(/’/g, "'");
      // "seventy-five" arrives as one word only when written with a hyphen; split it.
      for (const part of raw.split(/-/)) if (part) out.push({ kind: "word", text: part.toLowerCase(), raw: part });
    } else if (match[6]) {
      out.push({ kind: "punct", text: match[6].trim() || "-" });
    }
  }
  return out;
}

/**
 * Joins number words into numbers: "three hundred and fifty thousand" → 350000. Digits and words mix: "75 thousand".
 * A number that cannot be read stays as words.
 */
export function tokenize(text: string, lexicon: VoiceLexicon): Token[] {
  const raw = rawTokens(text.replace(/-/g, " - ").replace(/\s-\s(?=[a-z])/gi, "-").replace(/([a-z])-([a-z])/gi, "$1 $2"));
  const out: Token[] = [];
  let i = 0;
  const isWord = (index: number, words: string[]) => {
    const token = raw[index];
    return token?.kind === "word" && words.includes(token.text);
  };
  const numberWord = (index: number) => {
    const token = raw[index];
    if (!token) return false;
    if (token.kind === "digits") return true;
    if (token.kind !== "word") return false;
    return token.text in lexicon.units || token.text in lexicon.tens || token.text in lexicon.scales;
  };
  while (i < raw.length) {
    const token = raw[i]!;
    const startsNumber =
      token.kind === "digits" ||
      (token.kind === "word" &&
        (token.text in lexicon.units || token.text in lexicon.tens || (lexicon.half.includes(token.text) && !isWord(i - 1, lexicon.one)) ||
          (lexicon.one.includes(token.text) && raw[i + 1]?.kind === "word" && ((raw[i + 1] as WordToken).text in lexicon.scales || lexicon.half.includes((raw[i + 1] as WordToken).text)))));
    // "oh" and "k" alone are not numbers.
    if (!startsNumber || (token.kind === "word" && ["oh"].includes(token.text))) {
      out.push(token as WordToken | PunctToken);
      i += 1;
      continue;
    }
    const start = i;
    let total = 0n;
    let current = 0n;
    let last: "digit" | "unit" | "teen" | "ten" | "hundred" | "scale" | "one" | "point" | "half" | null = null;
    let usedScale = false;
    let symbol: string | null = null;
    let suffixMoney = false;
    while (i < raw.length) {
      const t = raw[i]!;
      if (t.kind === "digits") {
        if (last && last !== "hundred" && last !== "scale" && last !== "one") break;
        current += t.value;
        if (t.symbol) symbol = t.symbol;
        if (t.suffix) suffixMoney = true;
        last = "digit";
        i += 1;
        continue;
      }
      if (t.kind !== "word") break;
      const w = t.text;
      if (w in lexicon.units && w !== "oh") {
        const value = BigInt(lexicon.units[w]!) * SCALE;
        if (last === "digit" || last === "unit" || last === "teen" || last === "half") break;
        if (last === "ten" && lexicon.units[w]! >= 10) break;
        current += value;
        last = lexicon.units[w]! >= 10 ? "teen" : "unit";
        i += 1;
        continue;
      }
      if (w in lexicon.tens) {
        if (last === "digit" || last === "unit" || last === "teen" || last === "ten" || last === "half") break;
        current += BigInt(lexicon.tens[w]!) * SCALE;
        last = "ten";
        i += 1;
        continue;
      }
      if (w in lexicon.scales) {
        // "k" alone after a word number is money shorthand: "seventy five k".
        if (last === null) break;
        const scale = BigInt(lexicon.scales[w]!);
        if (scale === 100n) {
          current = (current === 0n ? SCALE : current) * 100n;
          last = "hundred";
        } else {
          total += (current === 0n ? SCALE : current) * scale;
          current = 0n;
          last = "scale";
          usedScale = true;
          if (w === "k") suffixMoney = true;
        }
        i += 1;
        continue;
      }
      if (lexicon.one.includes(w) && last === null && raw[i + 1]?.kind === "word") {
        const next = (raw[i + 1] as WordToken).text;
        if (next in lexicon.scales) {
          current = SCALE;
          last = "one";
          i += 1;
          continue;
        }
        if (lexicon.half.includes(next)) {
          current += 500n;
          last = "half";
          i += 2;
          continue;
        }
        break;
      }
      if (lexicon.half.includes(w) && last === null) {
        current += 500n;
        last = "half";
        i += 1;
        continue;
      }
      if (lexicon.numberJoin.includes(w) && last !== null) {
        // "one and a half", "three hundred and fifty"
        if (isWord(i + 1, lexicon.one) && isWord(i + 2, lexicon.half)) {
          current += 500n;
          last = "half";
          i += 3;
          continue;
        }
        if (isWord(i + 1, lexicon.half)) {
          current += 500n;
          last = "half";
          i += 2;
          continue;
        }
        if ((last === "hundred" || last === "scale") && numberWord(i + 1) && raw[i + 1]?.kind === "word" && !((raw[i + 1] as WordToken).text in lexicon.scales)) {
          i += 1;
          continue;
        }
        break;
      }
      if (lexicon.point.includes(w) && last !== null && last !== "point") {
        let j = i + 1;
        let digits = "";
        while (j < raw.length && digits.length < 3) {
          const d = raw[j]!;
          if (d.kind === "word" && d.text in lexicon.units && lexicon.units[d.text]! < 10) {
            digits += String(lexicon.units[d.text]);
            j += 1;
          } else break;
        }
        if (!digits) break;
        current += BigInt(digits.padEnd(3, "0"));
        last = "point";
        i = j;
        continue;
      }
      break;
    }
    if (i === start) {
      out.push(token as WordToken);
      i += 1;
      continue;
    }
    const value = total + current;
    // A currency word or coin right after the number: "five thousand naira", "fifty kobo".
    let currency: string | null = symbol ? (lexicon.currencies[symbol.toLowerCase()] ?? null) : null;
    let minor = false;
    const after = raw[i];
    if (after?.kind === "word" && after.text in lexicon.currencies && after.text !== "n") {
      currency = lexicon.currencies[after.text]!;
      i += 1;
    } else if (after?.kind === "word" && lexicon.minorCoins.includes(after.text)) {
      minor = true;
      i += 1;
    }
    out.push({
      kind: "num",
      value,
      moneyHint: Boolean(symbol) || suffixMoney || currency !== null || minor || (usedScale && value >= 1_000_000n),
      currency,
      minor,
      raw: raw
        .slice(start, i)
        .map((t) => ("raw" in t ? t.raw : t.kind === "punct" ? t.text : ""))
        .join(" "),
      start,
      end: i,
    });
  }
  return out;
}
