/** How close a typed name is to a product before it is only a suggestion (ADR-052). */

const MIN_LENGTH = 6;
const PREFIX = 4;
const MAX_EDITS = 2;

/** Insertions, deletions and substitutions. Names are short, so the full count is cheap. */
export function editDistance(left: string, right: string) {
  if (left === right) return 0;
  const width = right.length + 1;
  let previous = Array.from({ length: width }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j < width; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[width - 1] ?? 0;
}

/**
 * A close spelling, not the same compact name. Both names are at least 6 characters, they start with the same
 * 4, and at most 2 letters differ. A shorter name, or two products that both qualify, is left alone.
 */
export function closeProductKey(typedCompact: string, productCompact: string) {
  if (typedCompact.length < MIN_LENGTH || productCompact.length < MIN_LENGTH) return false;
  if (typedCompact === productCompact) return false;
  if (typedCompact.slice(0, PREFIX) !== productCompact.slice(0, PREFIX)) return false;
  return editDistance(typedCompact, productCompact) <= MAX_EDITS;
}
