"use client";

import type { CachedProduct } from "../lib/offline/catalog";
import { ScanButton } from "./scan-button";

/**
 * Scan on the sale screen (ADR-066): a code that is one product's barcode in the phone's list goes straight into the
 * sale; anything else is put in the search box. Loaded after the screen, so the sale screen stays within its budget.
 */
export function SaleScan({ products, onProduct, onText }: { products: Record<string, CachedProduct> | undefined; onProduct: (product: CachedProduct) => void; onText: (text: string) => void }) {
  return (
    <ScanButton
      onCode={(code) => {
        const matches = products ? Object.values(products).filter((product) => product.barcode === code) : [];
        if (matches.length === 1 && matches[0]) onProduct(matches[0]);
        else onText(code);
      }}
    />
  );
}
