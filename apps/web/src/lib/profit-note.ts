/** How much of the period's sales have no cost, for the note under the books' profit (ADR-051). */
export function uncostedSalesNote(
  salesMinor: string,
  uncostedSalesMinor: string | undefined,
  status: "known" | "partial" | "unknown" | undefined,
): { amountMinor: string; percent: number | "under1" } | null {
  if (!status || status === "known") return null;
  const sales = BigInt(salesMinor || "0");
  const missing = BigInt(uncostedSalesMinor || "0");
  if (sales <= 0n || missing <= 0n) return null;
  const percent = ((missing * 10000n) / sales + 50n) / 100n;
  return { amountMinor: missing.toString(), percent: percent < 1n ? "under1" : Number(percent) };
}
