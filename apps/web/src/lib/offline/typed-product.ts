import { savedItemKey, type SavedItem } from "@bizora/contracts";
import type { CachedProduct } from "./catalog";

/** A saved item shaped like a product, so the quick sale and voice treat both the same way. No stock is kept. */
export function asProduct(item: Pick<SavedItem, "name" | "unit" | "lastPriceMinor">): CachedProduct & { quantity: string } {
  return {
    id: `typed:${savedItemKey(item.name)}`,
    name: item.name,
    category: null,
    baseUnit: item.unit,
    priceMinor: item.lastPriceMinor,
    packs: [],
    lowStockLevel: null,
    barcode: null,
    trackStock: false,
    archived: false,
    typed: true,
    quantity: "0",
  };
}
