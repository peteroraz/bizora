"use client";

import { amountText, typeNumber } from "@bizora/contracts";
import { FormField } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency } from "../i18n/format";
import type { CachedProduct } from "../lib/offline/catalog";
import { listPrice, sellingUnits } from "../lib/sales-client";
import { useStockText, useUnitName } from "./stock-quantity";
import { AmountInput } from "./typing";

export type Line = { key: string; product: CachedProduct; unit: string; quantity: string; price: string };
type Priced = { line: Line; list: bigint | null; total: bigint | null; short: boolean; onHand: bigint };

/** Units offered for an item typed in (ADR-041). */
const TYPED_UNITS = ["piece", "pack", "carton", "bag", "sachet", "bottle", "tin", "crate", "dozen", "paint", "kg", "litre"] as const;

/**
 * The lines of a quick sale: how many, which unit, and the price. Loaded once the screen has opened (and on the first
 * tap at the latest), so the quick sale's opening download stays within its budget (ADR-041).
 */
export default function QuickSaleLines(props: {
  priced: Priced[];
  currency: string;
  canDiscount: boolean;
  priceOpen: string | null;
  onPriceOpen: (key: string) => void;
  onStep: (line: Line, by: bigint) => void;
  onChange: (key: string, change: Partial<Line>) => void;
}) {
  const { priced, currency, canDiscount, priceOpen, onPriceOpen, onStep, onChange } = props;
  const t = useTranslations("sales");
  const locale = useLocale();
  const unitName = useUnitName();
  const stockText = useStockText();
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);
  return (
    <ul className="divide-y divide-border">
      {priced.map(({ line, list, total: lineAmount, short, onHand }, index) => (
        <li key={line.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm font-medium">{line.product.name}</span>
            <span className="text-sm font-semibold tabular-nums">{lineAmount !== null ? money(lineAmount) : "–"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center">
              <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-l-control border border-border text-lg" aria-label={t("less", { name: line.product.name })} onClick={() => onStep(line, -1000n)}>
                −
              </button>
              <label htmlFor={`qty-${index}`} className="sr-only">
                {t("quantity")}
              </label>
              <input
                id={`qty-${index}`}
                inputMode="decimal"
                className="h-11 w-16 border-y border-border bg-input text-center text-base tabular-nums outline-none"
                value={line.quantity}
                onChange={(event) => onChange(line.key, { quantity: typeNumber(event.target.value, 3) })}
              />
              <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-r-control border border-border text-lg" aria-label={t("more", { name: line.product.name })} onClick={() => onStep(line, 1000n)}>
                +
              </button>
            </div>
            {line.product.typed ? (
              <select aria-label={t("unit")} className="h-11 rounded-control border border-border bg-input px-2 text-sm" value={line.unit} onChange={(event) => onChange(line.key, { unit: event.target.value })}>
                {TYPED_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unitName(unit, 1)}
                  </option>
                ))}
              </select>
            ) : sellingUnits(line.product).length > 1 ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label={t("unit")}>
                {sellingUnits(line.product).map((unit) => {
                  const unitPrice = listPrice(line.product, unit);
                  return (
                    <button
                      key={unit}
                      type="button"
                      aria-pressed={line.unit === unit}
                      className={`min-h-11 rounded-control border px-3 text-sm ${line.unit === unit ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
                      onClick={() => onChange(line.key, { unit, price: "" })}
                    >
                      {unitName(unit, 1)}
                      {unitPrice !== null ? <span className="ml-1 text-xs opacity-80">{money(unitPrice)}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-sm text-muted">{list !== null ? t("eachPrice", { price: money(list), unit: unitName(line.unit, 1) }) : t("noPriceShort")}</span>
            )}
          </div>
          {canDiscount || line.product.typed ? (
            priceOpen === line.key || line.price.trim() || line.product.typed ? (
              <FormField id={`price-${index}`} label={t("price")}>
                <AmountInput
                  currency={currency}
                  id={`price-${index}`}
                  className="max-w-40"
                  value={line.price}
                  placeholder={list !== null ? amountText(list, currency) : ""}
                  onChange={(event) => onChange(line.key, { price: event.target.value })}
                />
              </FormField>
            ) : (
              <button type="button" className="min-h-11 text-sm text-primary" onClick={() => onPriceOpen(line.key)}>
                {t("changePrice")}
              </button>
            )
          ) : null}
          {short ? <p className="text-xs text-warning">{t("shortStock", { quantity: stockText(onHand.toString(), line.product.baseUnit, line.product.packs) })}</p> : null}
        </li>
      ))}
    </ul>
  );
}
