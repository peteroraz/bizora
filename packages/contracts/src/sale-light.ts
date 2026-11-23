/**
 * Small sale helpers with no schemas, so the quick-sale screen can use them without loading the rest of sales.ts.
 * That screen is at its script-size limit (ADR-049).
 */

/** What staff can sell (ADR-041): only products from the list, any item typed in (remembered), or both. */
export const sellsProducts = (setting: string | null | undefined) => setting !== "typed";
export const sellsTyped = (setting: string | null | undefined) => setting === "typed" || setting === "both";

/**
 * The same name however it is typed: "Ogbono", "ogbono" and "Ogbono." are one item.
 * Sizes stay different: "Peak Milk 400g" is not "Peak Milk 900g".
 */
export function savedItemKey(name: string) {
  return name.trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").trim().toLowerCase().slice(0, 160);
}

/** The unit price to show when the person typed the line total. The sale stores that total itself; this figure is display only and can be a kobo or two short. */
export function unitPriceFromTotal(totalMinor: bigint, enteredThousandths: bigint) {
  if (enteredThousandths <= 0n) return 0n;
  return (totalMinor * 1000n) / enteredThousandths;
}
