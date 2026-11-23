import { currencyDigits } from "../typing.js";
import { ENGLISH, type VoiceLexicon } from "./lexicon.js";
import { tokenize, type NumberToken, type Token } from "./tokens.js";

/**
 * Reads a spoken or typed sale into structured fields with fixed rules, on the phone and with no network (ADR-040).
 * It never guesses an amount or a customer: what was not said stays empty, and anything that does not add up is
 * listed as an issue for the person to check before saving. Money is in the currency's smallest unit, as bigint.
 */
export type SpokenPayment = {
  method: "cash" | "transfer" | "pos";
  amountMinor: bigint | null;
  /** False when an amount was said without saying how ("paid 300k"): cash is shown, for the person to check. */
  methodSaid: boolean;
};

export type SpokenLine = {
  /** The product as said: "rice", "Dangote cement". */
  productText: string;
  /** The unit as said, and as a unit code when it is one Bizora knows ("bags" → bag). */
  unitText: string | null;
  unit: string | null;
  /** Thousandths of the unit said (5 bags → 5000n). Null when no quantity was said. */
  quantity: bigint | null;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint | null;
  /** An amount said with the item that could be the price of one or of all: "two bags of rice 150k". */
  unclearAmountMinor: bigint | null;
  /** Where the quantity came from when it was worked out: total ÷ price. */
  quantityWorkedOut: boolean;
};

export type SpokenIssue =
  | { code: "no_items" }
  | { code: "no_quantity"; line: number }
  | { code: "no_price"; line: number }
  | { code: "unclear_price"; line: number }
  | { code: "line_total_mismatch"; line: number; saidMinor: bigint; workedOutMinor: bigint }
  | { code: "total_mismatch"; saidMinor: bigint; workedOutMinor: bigint }
  | { code: "payment_mismatch"; totalMinor: bigint; paidMinor: bigint; balanceMinor: bigint }
  | { code: "overpaid"; totalMinor: bigint; paidMinor: bigint }
  | { code: "no_payment" }
  | { code: "currency_mismatch"; said: string; expected: string }
  | { code: "unused_amount"; amountMinor: bigint };

export type SpokenSale = {
  transcript: string;
  currency: string;
  lines: SpokenLine[];
  customerText: string | null;
  /** Payments said, by method. One without an amount means "paid in full this way". */
  payments: SpokenPayment[];
  paidMinor: bigint | null;
  balanceMinor: bigint | null;
  /** A total the speaker said. */
  saidTotalMinor: bigint | null;
  /** The total worked out from the lines, when every line has a price. */
  totalMinor: bigint | null;
  paidInFull: boolean;
  onCredit: boolean;
  issues: SpokenIssue[];
};

const THOUSANDTHS = 1000n;

function roundDivide(value: bigint, by: bigint) {
  return value >= 0n ? (value + by / 2n) / by : -((-value + by / 2n) / by);
}

/** A spoken amount (thousandths of a currency unit) in the currency's smallest unit. Coins are already small. */
function toMinor(token: NumberToken, currency: string) {
  if (token.minor) return token.value / THOUSANDTHS;
  const digits = BigInt(currencyDigits(currency));
  return roundDivide(token.value * 10n ** digits, THOUSANDTHS);
}

/** Price × quantity, rounded the way the server rounds a sale line. */
export function spokenLineTotal(unitPriceMinor: bigint, quantity: bigint) {
  return roundDivide(unitPriceMinor * quantity, THOUSANDTHS);
}

type Cursor = { tokens: Token[]; used: Set<number> };

const word = (token: Token | undefined): string | null => (token?.kind === "word" ? token.text : null);
const isPunct = (token: Token | undefined) => token?.kind === "punct";

function matchPhrase(tokens: Token[], at: number, phrase: string[]) {
  return phrase.every((part, offset) => word(tokens[at + offset]) === part);
}

function phraseAt(tokens: Token[], at: number, phrases: string[][]) {
  return phrases.find((phrase) => matchPhrase(tokens, at, phrase)) ?? null;
}

function splitPhrases(list: string[]) {
  return list.map((item) => item.split(" "));
}

export function parseSpokenSale(transcript: string, options: { currency: string; lexicon?: VoiceLexicon }): SpokenSale {
  const lexicon = options.lexicon ?? ENGLISH;
  const currency = options.currency.trim().toUpperCase();
  const tokens = tokenize(transcript, lexicon);
  const cursor: Cursor = { tokens, used: new Set() };
  const sale: SpokenSale = {
    transcript: transcript.trim(),
    currency,
    lines: [],
    customerText: null,
    payments: [],
    paidMinor: null,
    balanceMinor: null,
    saidTotalMinor: null,
    totalMinor: null,
    paidInFull: false,
    onCredit: false,
    issues: [],
  };
  const each = splitPhrases(lexicon.each);
  const per = splitPhrases(lexicon.per);
  const customerVerbs = splitPhrases(lexicon.customerVerbs);
  const stopWords = new Set([
    ...lexicon.at,
    ...lexicon.forTotal,
    ...lexicon.to,
    ...lexicon.paid,
    ...lexicon.balance,
    ...lexicon.filler,
    ...Object.keys(lexicon.methods),
    ...lexicon.numberJoin,
    "who",
    "which",
    "with",
    "from",
    "plus",
    "then",
    "but",
    "each",
    "per",
    "total",
    "altogether",
    "customer",
    "and",
    "sold",
    "sell",
    "by",
    "via",
    "on",
    "in",
  ]);
  const notName = new Set([...stopWords, ...lexicon.of, ...lexicon.one, "i", "we", "you", "my", "our", "a", "an", "of", "some", "no", "not", "did", "didn't", "will"]);
  const mismatched = new Set<string>();

  const money = (token: NumberToken) => {
    if (token.currency && token.currency !== currency) mismatched.add(token.currency);
    return toMinor(token, currency);
  };

  /** The next amount within a few words, skipping words that carry nothing ("he paid ME the SUM OF 20k"). */
  const amountAfter = (from: number, reach = 5): { index: number; token: NumberToken } | null => {
    for (let j = from; j < Math.min(tokens.length, from + reach); j += 1) {
      const token = tokens[j];
      if (token?.kind === "num" && !cursor.used.has(j)) return { index: j, token };
      if (isPunct(token) && (token as { text: string }).text !== ",") return null;
      const w = word(token);
      if (w && !lexicon.filler.includes(w) && !["of", "is", "be", "will", "remaining", "left", "with", "in", "by", "a", "to", "for", "deposit", "part", "first", "now", "today", "naira"].includes(w) && !(w in lexicon.methods)) return null;
    }
    return null;
  };

  const methodAt = (j: number): { method: "cash" | "transfer" | "pos"; length: number } | null => {
    const two = `${word(tokens[j]) ?? ""} ${word(tokens[j + 1]) ?? ""}`;
    if (two in lexicon.methods) return { method: lexicon.methods[two]!, length: 2 };
    const one = word(tokens[j]);
    if (one && one in lexicon.methods) return { method: lexicon.methods[one]!, length: 1 };
    return null;
  };

  const nameFrom = (from: number, max = 4) => {
    const parts: string[] = [];
    let j = from;
    while (j < tokens.length && parts.length < max) {
      const token = tokens[j];
      if (token?.kind !== "word") break;
      const w = token.text;
      if (notName.has(w) && !lexicon.honorifics.includes(w)) break;
      if (lexicon.unit(w)) break;
      parts.push(token.raw.charAt(0).toUpperCase() + token.raw.slice(1));
      j += 1;
    }
    // A name ends on a real name, not on a title.
    while (parts.length && lexicon.honorifics.includes(parts[parts.length - 1]!.toLowerCase())) parts.pop();
    return parts.length ? { name: parts.join(" "), end: j } : null;
  };

  // 1. Payments, balances and totals: "paid 300k", "balance 75k", "total 375k", "on credit", "cash".
  for (let i = 0; i < tokens.length; i += 1) {
    const w = word(tokens[i]);
    if (!w) continue;
    if (lexicon.paid.includes(w)) {
      // "transferred" and "paid" both start a payment; "transferred" also says how.
      const direct = w in lexicon.methods ? lexicon.methods[w]! : null;
      const unpaidAfter = tokens[i - 1] && word(tokens[i - 1]) === "not";
      if (unpaidAfter) {
        sale.onCredit = true;
        continue;
      }
      const full = phraseAt(tokens, i + 1, lexicon.paidInFull);
      if (full) {
        sale.paidInFull = true;
        for (let k = i; k <= i + full.length; k += 1) cursor.used.add(k);
      }
      let j = i + 1 + (full?.length ?? 0);
      let pendingMethod: "cash" | "transfer" | "pos" | null = direct;
      let found = false;
      // "paid 200k cash and 100k transfer", "paid cash 300k", "paid by pos"
      for (let guard = 0; guard < 6 && j < tokens.length; guard += 1) {
        const method = methodAt(j) ?? (["by", "via", "with", "through", "in"].includes(word(tokens[j]) ?? "") ? methodAt(j + 1) : null);
        if (method) {
          const skip = methodAt(j) ? method.length : method.length + 1;
          const last = sale.payments[sale.payments.length - 1];
          if (last && found && !last.methodSaid) {
            last.method = method.method;
            last.methodSaid = true;
          } else pendingMethod = method.method;
          for (let k = j; k < j + skip; k += 1) cursor.used.add(k);
          j += skip;
          continue;
        }
        // "…150k cash AND 36k transfer"
        if ((word(tokens[j]) === "and" || (isPunct(tokens[j]) && (tokens[j] as { text: string }).text === ",")) && found && (methodAt(j + 1) || amountAfter(j + 1, 3))) {
          j += 1;
          continue;
        }
        const amount = amountAfter(j, 5);
        if (amount) {
          cursor.used.add(amount.index);
          sale.payments.push({ method: pendingMethod ?? "cash", amountMinor: money(amount.token), methodSaid: pendingMethod !== null });
          pendingMethod = null;
          found = true;
          j = amount.index + 1;
          if (word(tokens[j]) === "and" || (tokens[j]?.kind === "punct" && (tokens[j] as { text: string }).text === ",")) {
            const nextMethod = methodAt(j + 1);
            const nextAmount = amountAfter(j + 1, 3);
            if (nextMethod || nextAmount) {
              j += 1;
              continue;
            }
          }
          continue;
        }
        break;
      }
      if (!found && pendingMethod) sale.payments.push({ method: pendingMethod, amountMinor: null, methodSaid: true });
      cursor.used.add(i);
      continue;
    }
    if (lexicon.balance.includes(w)) {
      // "will balance 75k", "balance is 16k", "remaining 16k", "he owes 16k"
      const amount = amountAfter(i + 1, 4);
      if (amount) {
        sale.balanceMinor = money(amount.token);
        cursor.used.add(amount.index);
        cursor.used.add(i);
      }
      continue;
    }
    const total = phraseAt(tokens, i, lexicon.total);
    if (total) {
      const amount = amountAfter(i + total.length, 4);
      if (amount) {
        sale.saidTotalMinor = money(amount.token);
        cursor.used.add(amount.index);
      }
      continue;
    }
    const unpaid = phraseAt(tokens, i, lexicon.unpaid);
    if (unpaid && !lexicon.paid.includes(w)) {
      sale.onCredit = true;
      i += unpaid.length - 1;
      continue;
    }
  }
  // A method said on its own ("…, transfer.") is how it was paid.
  for (let i = 0; i < tokens.length; i += 1) {
    if (cursor.used.has(i)) continue;
    const method = methodAt(i);
    if (!method) continue;
    const before = word(tokens[i - 1]);
    if (before && (lexicon.unit(before) || before === "of")) continue;
    const unsaid = sale.payments.find((payment) => !payment.methodSaid);
    if (unsaid) {
      unsaid.method = method.method;
      unsaid.methodSaid = true;
    } else if (!sale.payments.some((payment) => payment.method === method.method)) sale.payments.push({ method: method.method, amountMinor: null, methodSaid: true });
    for (let k = i; k < i + method.length; k += 1) cursor.used.add(k);
  }

  // 2. The customer: "…to Emeka", "Chinedu collected…", "customer is Mama Ngozi".
  for (let i = 0; i < tokens.length && !sale.customerText; i += 1) {
    const w = word(tokens[i]);
    if (!w) continue;
    if (lexicon.to.includes(w) && i > 0) {
      const next = word(tokens[i + 1]);
      if (!next || lexicon.balance.includes(next) || lexicon.paid.includes(next) || next === "the" || next === "be") continue;
      const found = nameFrom(i + 1);
      if (found) {
        sale.customerText = found.name;
        for (let k = i; k < found.end; k += 1) cursor.used.add(k);
      }
      continue;
    }
    if (lexicon.customerWord.includes(w)) {
      let j = i + 1;
      while (["is", "name", "named", "called", ":", "was"].includes(word(tokens[j]) ?? (tokens[j]?.kind === "punct" ? (tokens[j] as { text: string }).text : ""))) j += 1;
      const found = nameFrom(j);
      if (found) {
        sale.customerText = found.name;
        for (let k = i; k < found.end; k += 1) cursor.used.add(k);
      }
      continue;
    }
  }
  if (!sale.customerText) {
    // A name at the start of a sentence, before a sale verb: "Chinedu collected three cartons…"
    for (let i = 0; i < tokens.length; i += 1) {
      const verb = phraseAt(tokens, i, customerVerbs);
      if (!verb || i === 0) continue;
      let start = i - 1;
      while (start > 0 && tokens[start - 1]?.kind === "word" && i - start < 4) start -= 1;
      // Back to the start of the sentence only.
      for (let k = i - 1; k >= 0; k -= 1) {
        if (isPunct(tokens[k]) && [".", ";", "!", "?"].includes((tokens[k] as { text: string }).text)) {
          start = Math.max(start, k + 1);
          break;
        }
      }
      const found = nameFrom(start, i - start);
      if (found && found.end === i) {
        sale.customerText = found.name;
        for (let k = start; k < i; k += 1) cursor.used.add(k);
        break;
      }
    }
  }

  // 3. Items: "five bags of rice at 75k each", "three cartons of Indomie, twelve thousand each", "a crate of eggs".
  for (let i = 0; i < tokens.length; i += 1) {
    if (cursor.used.has(i)) continue;
    const token = tokens[i]!;
    let quantity: bigint | null = null;
    let j = i;
    if (token.kind === "num") {
      // Money on its own ("₦5,000") is a price for the item before it, not a quantity.
      const nextWord = word(tokens[i + 1]);
      const nextIsUnit = nextWord ? Boolean(lexicon.unit(nextWord)) : false;
      if (token.moneyHint && !nextIsUnit) continue;
      quantity = token.value;
      j = i + 1;
    } else if (token.kind === "word" && lexicon.one.includes(token.text)) {
      const next = word(tokens[i + 1]);
      if (!next || !lexicon.unit(next)) continue;
      quantity = THOUSANDTHS;
      j = i + 1;
    } else continue;

    let unitText: string | null = null;
    let unit: string | null = null;
    const takeUnit = (w: string) => {
      const code = lexicon.unit(w);
      if (!code || unitText) return false;
      unitText = w;
      unit = code;
      return true;
    };
    const unitWord = word(tokens[j]);
    if (unitWord && takeUnit(unitWord)) j += 1;
    if (lexicon.of.includes(word(tokens[j]) ?? "")) j += 1;
    const productWords: string[] = [];
    while (j < tokens.length) {
      const t = tokens[j];
      if (t?.kind !== "word") break;
      if (stopWords.has(t.text) && !(productWords.length === 0 && lexicon.one.includes(t.text))) break;
      if (lexicon.one.includes(t.text) || t.text === "the") {
        j += 1;
        continue;
      }
      // "five rice bags", "Indomie carton": the unit after the product.
      if (takeUnit(t.text)) {
        j += 1;
        continue;
      }
      if (lexicon.of.includes(t.text) && productWords.length === 0) {
        j += 1;
        continue;
      }
      productWords.push(t.raw);
      j += 1;
    }
    if (productWords.length === 0) continue;
    for (let k = i; k < j; k += 1) cursor.used.add(k);
    const line: SpokenLine = {
      productText: productWords.join(" "),
      unitText,
      unit,
      quantity,
      unitPriceMinor: null,
      lineTotalMinor: null,
      unclearAmountMinor: null,
      quantityWorkedOut: false,
    };
    // The price, said right after the item.
    let k = j;
    if (isPunct(tokens[k]) && (tokens[k] as { text: string }).text === ",") k += 1;
    const marker = word(tokens[k]);
    const isAt = marker !== null && lexicon.at.includes(marker);
    const isFor = marker !== null && lexicon.forTotal.includes(marker);
    if (isAt || isFor) k += 1;
    const priceToken = tokens[k];
    if (priceToken?.kind === "num" && !cursor.used.has(k)) {
      const amount = money(priceToken);
      cursor.used.add(k);
      let after = k + 1;
      const eachPhrase = phraseAt(tokens, after, each);
      let perUnit = false;
      if (eachPhrase) {
        perUnit = true;
        after += eachPhrase.length;
      } else {
        const perPhrase = phraseAt(tokens, after, per);
        const unitAfter = perPhrase ? word(tokens[after + perPhrase.length]) : null;
        if (perPhrase && unitAfter && (lexicon.unit(unitAfter) || unitAfter === "one")) {
          perUnit = true;
          after += perPhrase.length + 1;
        }
      }
      for (let m = k + 1; m < after; m += 1) cursor.used.add(m);
      if (perUnit || isAt) line.unitPriceMinor = amount;
      else if (isFor) line.lineTotalMinor = amount;
      else if (quantity === THOUSANDTHS) line.unitPriceMinor = amount;
      else line.unclearAmountMinor = amount;
    }
    sale.lines.push(line);
  }

  // Money said on its own after an item with no price: "two crates of Coke. Three thousand each."
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind !== "num" || cursor.used.has(i)) continue;
    const eachPhrase = phraseAt(tokens, i + 1, each);
    const target = [...sale.lines].reverse().find((line) => line.unitPriceMinor === null && line.lineTotalMinor === null && line.unclearAmountMinor === null);
    if (target && (eachPhrase || token.moneyHint)) {
      if (eachPhrase) target.unitPriceMinor = money(token);
      else target.unclearAmountMinor = money(token);
      cursor.used.add(i);
      continue;
    }
    if (token.moneyHint || token.value >= 1_000_000n) sale.issues.push({ code: "unused_amount", amountMinor: money(token) });
  }

  for (const code of mismatched) sale.issues.push({ code: "currency_mismatch", said: code, expected: currency });
  finish(sale);
  return sale;
}

/**
 * Works out what follows from what was said, and lists what does not add up. Called again after the person or the
 * catalogue fills a gap (a price, a quantity), so the checks always match the fields on screen.
 */
export function finish(sale: SpokenSale): SpokenSale {
  const keep = sale.issues.filter((issue) => issue.code === "currency_mismatch" || issue.code === "unused_amount");
  const issues: SpokenIssue[] = [...keep];
  if (sale.lines.length === 0) issues.push({ code: "no_items" });
  let total = 0n;
  let allPriced = sale.lines.length > 0;
  sale.lines.forEach((line, index) => {
    if (line.quantity === null && line.unitPriceMinor !== null && line.lineTotalMinor !== null && line.unitPriceMinor > 0n) {
      // "Indomie, twelve thousand each, thirty-six thousand": 3 cartons.
      const thousandths = (line.lineTotalMinor * THOUSANDTHS) / line.unitPriceMinor;
      if ((line.lineTotalMinor * THOUSANDTHS) % line.unitPriceMinor === 0n) {
        line.quantity = thousandths;
        line.quantityWorkedOut = true;
      }
    }
    if (line.quantity === null) issues.push({ code: "no_quantity", line: index });
    if (line.unitPriceMinor === null && line.lineTotalMinor !== null && line.quantity !== null && line.quantity > 0n) {
      const price = (line.lineTotalMinor * THOUSANDTHS) / line.quantity;
      if ((line.lineTotalMinor * THOUSANDTHS) % line.quantity === 0n) line.unitPriceMinor = price;
    }
    if (line.unclearAmountMinor !== null && line.unitPriceMinor === null && line.lineTotalMinor === null) {
      issues.push({ code: "unclear_price", line: index });
      allPriced = false;
      return;
    }
    if (line.unitPriceMinor === null && line.lineTotalMinor === null) {
      issues.push({ code: "no_price", line: index });
      allPriced = false;
      return;
    }
    if (line.quantity === null) {
      allPriced = false;
      return;
    }
    const workedOut = line.unitPriceMinor !== null ? spokenLineTotal(line.unitPriceMinor, line.quantity) : line.lineTotalMinor!;
    if (line.lineTotalMinor !== null && line.unitPriceMinor !== null && workedOut !== line.lineTotalMinor) {
      issues.push({ code: "line_total_mismatch", line: index, saidMinor: line.lineTotalMinor, workedOutMinor: workedOut });
    }
    total += workedOut;
  });
  sale.totalMinor = allPriced ? total : null;
  if (sale.saidTotalMinor !== null && sale.totalMinor !== null && sale.saidTotalMinor !== sale.totalMinor) {
    issues.push({ code: "total_mismatch", saidMinor: sale.saidTotalMinor, workedOutMinor: sale.totalMinor });
  }
  const reference = sale.totalMinor ?? sale.saidTotalMinor;
  const saidPaid = sale.payments.some((payment) => payment.amountMinor !== null)
    ? sale.payments.reduce((sum, payment) => sum + (payment.amountMinor ?? 0n), 0n)
    : null;
  sale.paidMinor = saidPaid;
  if (sale.onCredit && saidPaid === null && sale.balanceMinor === null) {
    sale.paidMinor = 0n;
    if (reference !== null) sale.balanceMinor = reference;
  } else if (saidPaid === null && sale.balanceMinor !== null && reference !== null) {
    // "…balance sixteen thousand": the rest was paid.
    sale.paidMinor = reference - sale.balanceMinor;
  } else if (saidPaid === null && (sale.paidInFull || sale.payments.length > 0) && reference !== null) {
    // "paid cash", "paid in full", "transfer": all of it.
    sale.paidMinor = reference;
    sale.paidInFull = true;
  }
  if (sale.paidMinor !== null && reference !== null) {
    if (sale.paidMinor > reference) issues.push({ code: "overpaid", totalMinor: reference, paidMinor: sale.paidMinor });
    else if (sale.balanceMinor !== null && sale.paidMinor + sale.balanceMinor !== reference) {
      issues.push({ code: "payment_mismatch", totalMinor: reference, paidMinor: sale.paidMinor, balanceMinor: sale.balanceMinor });
    } else if (sale.balanceMinor === null) sale.balanceMinor = reference - sale.paidMinor;
  }
  if (sale.paidMinor === null && !sale.onCredit) issues.push({ code: "no_payment" });
  sale.issues = issues;
  return sale;
}
