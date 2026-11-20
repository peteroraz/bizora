import { ENGLISH, type VoiceLexicon } from "./lexicon.js";

/**
 * Finds what a spoken name means among this shop's products or customers, on the phone (ADR-040). Spelling and
 * sound both count, so "pick milk" finds "Peak Milk" and "indomi" finds "Indomie". When two are close, the person
 * chooses; nothing is picked silently.
 */
export type Ranked<T> = { item: T; score: number };
export type Decision<T> = { status: "sure" | "choose" | "none"; best: T | null; options: T[] };

const STOP = new Set(["of", "the", "a", "an", "and", "&", "for", "with"]);

export function normalizeName(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(text: string, lexicon: VoiceLexicon, dropUnits: boolean, people: boolean) {
  return normalizeName(text)
    .split(" ")
    .filter((word) => word && !STOP.has(word) && !(dropUnits && lexicon.unit(word)) && !(people && lexicon.honorifics.includes(word)));
}

/** Jaro-Winkler similarity, 0 to 1. */
export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** A rough sound key, so words that sound alike match: "peak"/"pick", "coke"/"kok", "indomie"/"indomee". */
export function soundKey(word: string) {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/x/g, "ks")
    .replace(/dg/g, "j")
    .replace(/gh/g, "g")
    .replace(/wh/g, "w")
    .replace(/z/g, "s")
    .replace(/v/g, "f");
  const first = w[0]!;
  const rest = w
    .slice(1)
    .replace(/[aeiouyhw]/g, "")
    .replace(/(.)\1+/g, "$1");
  return (first.replace(/[aeiouy]/, "a") + rest).slice(0, 5);
}

function wordSimilarity(a: string, b: string) {
  if (a === b) return 1;
  // Numbers and sizes must match exactly: "50kg" is not "25kg".
  if (/\d/.test(a) || /\d/.test(b)) return a === b ? 1 : 0;
  let score = jaroWinkler(a, b);
  if (a.length >= 3 && b.startsWith(a)) score = Math.max(score, 0.9);
  if (a.length >= 3 && soundKey(a) === soundKey(b)) score = Math.max(score, 0.9);
  return score;
}

/** How well a spoken name fits a known name, 0 to 1. */
export function nameScore(spoken: string, known: string, options: { lexicon?: VoiceLexicon; dropUnits?: boolean; people?: boolean } = {}) {
  const lexicon = options.lexicon ?? ENGLISH;
  const people = options.people ?? false;
  const dropUnits = options.dropUnits ?? !people;
  if (normalizeName(spoken) === normalizeName(known)) return 1;
  const said = words(spoken, lexicon, dropUnits, people);
  const name = words(known, lexicon, dropUnits, people);
  if (!said.length || !name.length) return 0;
  if (said.join("") === name.join("")) return 1;
  let saidTotal = 0;
  const used = new Set<number>();
  for (const word of said) {
    let best = 0;
    let bestIndex = -1;
    name.forEach((candidate, index) => {
      const score = wordSimilarity(word, candidate);
      if (score > best) {
        best = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && best >= 0.8) used.add(bestIndex);
    saidTotal += best;
  }
  const coverage = saidTotal / said.length;
  const known_ = used.size / name.length;
  return Math.round((coverage * 0.75 + known_ * 0.25) * 1000) / 1000;
}

export function rank<T>(spoken: string, items: T[], nameOf: (item: T) => string[], options: { lexicon?: VoiceLexicon; dropUnits?: boolean; people?: boolean; limit?: number } = {}): Ranked<T>[] {
  if (!spoken.trim()) return [];
  return items
    .map((item) => ({ item, score: Math.max(...nameOf(item).map((name) => nameScore(spoken, name, options))) }))
    .filter((entry) => entry.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);
}

/** Sure when one name clearly fits; a choice when several fit about as well; none when nothing fits. */
export function decide<T>(ranked: Ranked<T>[]): Decision<T> {
  const [first, second] = ranked;
  if (!first || first.score < 0.7) return { status: "none", best: null, options: ranked.map((entry) => entry.item) };
  const close = ranked.filter((entry) => entry.score >= first.score - 0.06);
  const clear = !second || second.score < first.score - 0.06;
  // A strong fit with nothing near it is sure; a fair fit needs a clear lead.
  if ((first.score >= 0.85 && clear) || (first.score >= 0.78 && (!second || second.score < first.score - 0.15))) return { status: "sure", best: first.item, options: ranked.map((entry) => entry.item) };
  return { status: "choose", best: close.length === 1 ? first.item : null, options: ranked.map((entry) => entry.item) };
}
