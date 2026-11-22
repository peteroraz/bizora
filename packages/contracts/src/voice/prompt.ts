import { ENGLISH, type VoiceLexicon } from "./lexicon.js";

/**
 * The words given to the speech model before it listens (ADR-041): how money is said here and this shop's own product
 * and customer names, so it writes "naira" and "Emeka" rather than "near a" and "America". The benchmark (docs/voice)
 * found this the biggest single gain for sales. Kept short: Whisper reads at most about 220 tokens of prompt.
 */
export function speechPrompt(input: { currency: string; products: string[]; customers: string[]; lexicon?: VoiceLexicon; maxLength?: number }) {
  const lexicon = input.lexicon ?? ENGLISH;
  const money = Object.entries(lexicon.currencies).find(([word, code]) => code === input.currency && /^[a-z]{3,}$/.test(word))?.[0];
  const opening = `${money ? `Sold in ${money}` : "Sold"}, cash, transfer or POS.`;
  const limit = input.maxLength ?? 600;
  const unique = (names: string[]) => [...new Set(names.map((name) => name.trim().replace(/\s+/g, " ")).filter((name) => name.length > 1))];
  let text = opening;
  const add = (names: string[], take: number) => {
    const picked: string[] = [];
    for (const name of unique(names).slice(0, take)) {
      if (text.length + picked.join(", ").length + name.length + 4 > limit) break;
      picked.push(name);
    }
    if (picked.length) text += ` ${picked.join(", ")}.`;
  };
  add(input.products, 40);
  add(input.customers, 20);
  return text;
}
