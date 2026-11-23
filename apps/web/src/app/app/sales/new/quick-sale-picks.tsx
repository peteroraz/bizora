"use client";

import { capitaliseFirst } from "@bizora/contracts";
import { useTranslations } from "next-intl";
import type { CachedProduct } from "../../../../lib/offline/catalog";
import { asProduct } from "../../../../lib/offline/typed-product";

type PickProduct = CachedProduct & { quantity: string };

/**
 * The product search results and quick tiles. Loaded after the quick sale screen opens so they are not part of
 * the first script (that screen is at its size limit).
 */
export function QuickSalePicks({
  query,
  matches,
  tiles,
  catalogReady,
  typedOk,
  asked,
  onAdd,
  money,
  stockText,
}: {
  query: string;
  matches: PickProduct[];
  tiles: PickProduct[];
  catalogReady: boolean;
  typedOk: boolean;
  asked: string;
  onAdd: (product: CachedProduct) => void;
  money: (minor: bigint) => string;
  stockText: (quantity: string, baseUnit: string, packs: CachedProduct["packs"]) => string;
}) {
  const t = useTranslations("sales");
  return (
    <>
      {matches.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card" aria-label={t("matches")}>
          {matches.map((product) => (
            <li key={product.id}>
              <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left" onClick={() => onAdd(product)}>
                <span className="text-sm font-medium">{product.name}</span>
                <span className="text-right text-sm text-muted">
                  {product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}
                  {product.trackStock ? ` · ${stockText(product.quantity, product.baseUnit, product.packs)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() && catalogReady && !typedOk ? (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      ) : !asked && tiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={t("quickPicks")} data-testid="product-tiles">
          {tiles.map((product) => (
            <button
              key={product.id}
              type="button"
              className="flex min-h-16 flex-col items-start justify-between rounded-card border border-border bg-card px-3 py-2 text-left hover:border-primary"
              onClick={() => onAdd(product)}
            >
              <span className="line-clamp-2 text-sm font-medium leading-tight">{product.name}</span>
              <span className="text-xs text-muted">{product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}</span>
            </button>
          ))}
        </div>
      ) : null}
      {typedOk && asked && !matches.some((item) => item.name.toLowerCase() === asked) ? (
        <button type="button" className="min-h-12 w-full rounded-card border border-dashed border-primary px-4 text-left text-sm font-medium text-primary" data-testid="sell-typed" onClick={() => onAdd(asProduct({ name: capitaliseFirst(query.trim()), unit: "piece", lastPriceMinor: null }))}>
          {t("typed.sell", { name: capitaliseFirst(query.trim()) })}
        </button>
      ) : null}
    </>
  );
}
