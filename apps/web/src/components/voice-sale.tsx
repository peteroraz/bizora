"use client";

import { parseQuantity, paymentFromText, unitFromText, type CaptureResult } from "@bizora/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { CachedProduct } from "../lib/offline/catalog";
import { sellingUnits } from "../lib/sales-client";
import { CaptureBar } from "./capture-bar";

export type SpokenLine = { product: CachedProduct; unit: string; quantity: string; price: string };
export type SpokenSale = { lines: SpokenLine[]; payment: "cash" | "transfer" | "pos" | "credit" | null; paid: string; customer: string; unmatched: string[] };

const plain = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** The product a spoken name means: the same name, or the only product whose name contains it (or is contained). */
function findProduct(products: CachedProduct[], spoken: string) {
  const name = plain(spoken);
  if (!name) return null;
  const exact = products.find((product) => plain(product.name) === name);
  if (exact) return exact;
  const close = products.filter((product) => plain(product.name).includes(name) || name.includes(plain(product.name)));
  return close.length === 1 ? (close[0] as CachedProduct) : null;
}

const quantityText = (thousandths: bigint) =>
  thousandths % 1000n === 0n ? (thousandths / 1000n).toString() : `${thousandths / 1000n}.${(thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "")}`;

/**
 * Say the sale (ADR-033): "two cartons of Indomie and one bag of rice, cash" fills the cart. Loaded only when the
 * cashier taps the microphone, so the quick sale screen stays light. The cart is checked and charged as usual.
 */
export default function VoiceSale({ products, onSale }: { products: CachedProduct[]; onSale: (sale: SpokenSale) => void }) {
  const t = useTranslations("sales.voice");
  const [heard, setHeard] = useState<string | null>(null);

  function apply(result: CaptureResult) {
    const lines: SpokenLine[] = [];
    const unmatched: string[] = [];
    for (const row of result.rows) {
      const spoken = row.product ?? "";
      const product = findProduct(products, spoken);
      if (!product) {
        if (spoken.trim()) unmatched.push(spoken.trim());
        continue;
      }
      const said = row.unit ? unitFromText(row.unit) : null;
      const unit = said && sellingUnits(product).includes(said) ? said : product.baseUnit;
      const quantity = parseQuantity(row.quantity ?? "") ?? 1000n;
      lines.push({ product, unit, quantity: quantityText(quantity > 0n ? quantity : 1000n), price: (row.price ?? "").replace(/[^\d.]/g, "") });
    }
    const first = result.rows[0] ?? {};
    setHeard(result.transcript);
    onSale({ lines, payment: first.payment?.trim() ? paymentFromText(first.payment) : null, paid: (first.paid ?? "").replace(/[^\d.]/g, ""), customer: (first.customer ?? "").trim(), unmatched });
  }

  return (
    <div className="space-y-2" data-testid="voice-sale">
      <CaptureBar target="cart" onRows={apply} compact />
      {heard ? <p className="text-sm text-muted">{t("heard", { words: heard })}</p> : null}
    </div>
  );
}
