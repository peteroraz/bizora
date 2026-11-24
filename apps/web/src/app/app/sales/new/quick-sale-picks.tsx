"use client";

import { capitaliseFirst, compactItemKey, isExactListedName, matchSaleItems, savedItemKey, TYPED_ITEM_NAME_MAX } from "@bizora/contracts";
import { looksLikeSpokenSale } from "@bizora/contracts/voice";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { useUnitName } from "../../../../components/stock-quantity";
import { searchCatalog, type CachedProduct, type Catalog } from "../../../../lib/offline/catalog";
import { asProduct } from "../../../../lib/offline/typed-product";

type PickProduct = CachedProduct & { quantity: string };

/**
 * The product search results and quick tiles. Loaded after the quick sale screen opens so they are not part of
 * the first script (that screen is at its size limit).
 */
export function QuickSalePicks({
  query,
  catalog,
  savedList,
  productAliases,
  recent,
  listOk,
  typedOk,
  onAdd,
  onReadAsSale,
  money,
  stockText,
}: {
  query: string;
  catalog: Catalog | null;
  savedList: PickProduct[];
  productAliases: Record<string, string[]>;
  recent: string[];
  listOk: boolean;
  typedOk: boolean;
  onAdd: (product: CachedProduct) => void;
  /** A whole sale typed in the search box is read as a sale, not made into one item (ADR-057). */
  onReadAsSale?: (text: string) => void;
  money: (minor: bigint) => string;
  stockText: (quantity: string, baseUnit: string, packs: CachedProduct["packs"]) => string;
}) {
  const t = useTranslations("sales");
  const unitName = useUnitName();
  const asked = query.trim().toLowerCase();
  const askedKey = savedItemKey(query);
  // Ranked after the screen has opened, so this search is not part of the first script (ADR-049).
  const matches = useMemo(() => {
    if (!asked) return [];
    const remembered = new Map(savedList.map((item) => [savedItemKey(item.name), item]));
    const inputs = [
      ...(listOk && catalog
        ? Object.values(catalog.products)
            .filter((product) => !product.archived)
            .map((product) => {
              const memory = remembered.get(savedItemKey(product.name));
              const aliases = [...(productAliases[product.id] ?? []), ...(memory?.aliases ?? []), ...(product.category ? [product.category] : [])];
              return {
                item: { ...product, quantity: catalog.quantities[product.id] ?? "0", aliases, timesSold: memory?.timesSold, lastSoldAt: memory?.lastSoldAt ?? null },
                name: product.name,
                aliases,
                codes: [product.barcode],
                timesSold: memory?.timesSold ?? 0,
                lastSoldAt: memory?.lastSoldAt,
                managed: true,
              };
            })
        : []),
      ...savedList
        .filter((item) => !item.productId && !(listOk && catalog && Object.values(catalog.products).some((product) => !product.archived && savedItemKey(product.name) === savedItemKey(item.name))))
        .map((item) => ({ item: { ...item, quantity: "0" }, name: item.name, aliases: item.aliases, timesSold: item.timesSold, lastSoldAt: item.lastSoldAt, managed: false })),
    ];
    return matchSaleItems(query, inputs, 8).map((hit) => hit.item);
  }, [catalog, query, asked, listOk, savedList, productAliases]);
  const aliasesFor = (item: PickProduct) => (item.typed ? [] : [...(productAliases[item.id] ?? []), ...(savedList.find((saved) => saved.productId === item.id)?.aliases ?? [])]);
  const shown = [...matches].sort((a, b) => Number(!b.typed && isExactListedName(query, b.name, aliasesFor(b))) - Number(!a.typed && isExactListedName(query, a.name, aliasesFor(a))));
  useEffect(() => {
    const box = document.getElementById("sale-search");
    if (!box) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const chosen = matches.find((item) => {
        if (item.typed) return false;
        const aliases = [...(productAliases[item.id] ?? []), ...(savedList.find((saved) => saved.productId === item.id)?.aliases ?? [])];
        return isExactListedName(query, item.name, aliases);
      });
      if (!chosen) return;
      event.preventDefault();
      onAdd(chosen);
    };
    box.addEventListener("keydown", onKey);
    return () => box.removeEventListener("keydown", onKey);
  }, [matches, onAdd, query, productAliases, savedList]);
  const tiles = useMemo(() => {
    const remembered = savedList.filter((item) => !item.productId).slice(0, 8);
    if (!listOk) return remembered.slice(0, 12);
    if (!catalog) return remembered;
    const all = searchCatalog(catalog, "");
    const byId = new Map(all.map((product) => [product.id, product]));
    const first = recent.map((id) => byId.get(id)).filter((product): product is NonNullable<typeof product> => Boolean(product));
    const seen = new Set([...remembered.map((item) => savedItemKey(item.name)), ...first.map((product) => product.id)]);
    return [...remembered, ...first, ...all.filter((product) => !seen.has(product.id) && !seen.has(savedItemKey(product.name)))].slice(0, 12);
  }, [catalog, recent, listOk, savedList]);
  const askedCompact = compactItemKey(query);
  const taken =
    Boolean(askedKey || askedCompact) &&
    matches.some(
      (item) =>
        (askedKey && (savedItemKey(item.name) === askedKey || item.aliases?.some((alias) => savedItemKey(alias) === askedKey))) ||
        (askedCompact.length > 0 && (compactItemKey(item.name) === askedCompact || item.aliases?.some((alias) => compactItemKey(alias) === askedCompact))),
    );
  const sentence = Boolean(onReadAsSale) && looksLikeSpokenSale(query);
  const tooLong = query.trim().length > TYPED_ITEM_NAME_MAX;
  return (
    <>
      {sentence && onReadAsSale ? (
        <button
          type="button"
          className="min-h-12 w-full rounded-card bg-primary px-4 text-left text-sm font-semibold text-primary-fg"
          data-testid="read-as-sale"
          onClick={() => onReadAsSale(query.trim())}
        >
          {t("readAsSale")}
        </button>
      ) : null}
      {shown.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card" aria-label={t("matches")}>
          {shown.map((product) => (
            <li key={product.id}>
              <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left" onClick={() => onAdd(product)}>
                <span>
                  <span className="block text-sm font-medium">{product.name}</span>
                  {product.typed && product.priceMinor ? <span className="block text-xs text-muted">{t("typed.last", { price: money(BigInt(product.priceMinor)), unit: unitName(product.baseUnit, 1) })}</span> : null}
                  {product.timesSold ? <span className="block text-xs text-muted">{t("typed.used", { count: product.timesSold })}</span> : null}
                </span>
                <span className="text-right text-sm text-muted">
                  {product.typed ? "" : product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}
                  {product.trackStock ? ` · ${stockText(product.quantity, product.baseUnit, product.packs)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() && catalog && !typedOk ? (
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
      {typedOk && askedKey && !taken && tooLong ? <p className="text-sm text-muted">{t("typed.tooLong", { max: TYPED_ITEM_NAME_MAX })}</p> : null}
      {typedOk && askedKey && !taken && !tooLong ? (
        <button type="button" className="min-h-12 w-full rounded-card border border-dashed border-primary px-4 text-left text-sm font-medium text-primary" data-testid="sell-typed" onClick={() => onAdd(asProduct({ name: capitaliseFirst(query.trim()), unit: "piece", lastPriceMinor: null }))}>
          {t("typed.sell", { name: capitaliseFirst(query.trim()) })}
        </button>
      ) : null}
    </>
  );
}
