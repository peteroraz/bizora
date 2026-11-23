"use client";

import { parseQuantity } from "@bizora/contracts";
import { FormField } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

export type Tier = { min: bigint; price: bigint };
/** Prices from a price list (ADR-048), by product and unit, largest minimum quantity first. */
export type ListPrices = { id: string; name: string; tiers: Map<string, Tier[]> };

type Prices = { priceList: { id: string; name: string } | null; prices: { productId: string; unitCode: string; minQuantity: string; priceMinor: string }[] };

/**
 * The price list on the quick sale (ADR-048), loaded after the screen opens to keep it within its script budget.
 * The same rule as the sale: the list chosen here, else the customer's. Offline, the everyday prices are used.
 */
export default function SalePriceList({ customerId, chosen, onChosen, onPrices }: { customerId: string | null; chosen: string; onChosen: (id: string) => void; onPrices: (prices: ListPrices | null) => void }) {
  const t = useTranslations("sales");
  const [lists, setLists] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    void api("/api/v1/pricing/lists")
      .then(async (response) => (response.ok ? ((await response.json()) as { data: { lists: { id: string; name: string; active: boolean }[] } }).data.lists : []))
      .then((all) => setLists(all.filter((list) => list.active)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!chosen && !customerId) {
      setCurrent(null);
      onPrices(null);
      return;
    }
    let live = true;
    const query = new URLSearchParams({ ...(chosen ? { priceListId: chosen } : {}), ...(customerId ? { customerId } : {}) });
    void api(`/api/v1/pricing/for-sale?${query.toString()}`)
      .then(async (response) => (response.ok ? ((await response.json()) as { data: Prices }).data : null))
      .then((data) => {
        if (!live) return;
        const list = data?.priceList;
        setCurrent(list?.name ?? null);
        if (!list) return onPrices(null);
        const tiers = new Map<string, Tier[]>();
        for (const price of data.prices) {
          const key = `${price.productId}:${price.unitCode}`;
          tiers.set(key, [...(tiers.get(key) ?? []), { min: parseQuantity(price.minQuantity) ?? 1000n, price: BigInt(price.priceMinor) }].sort((a, b) => (b.min > a.min ? 1 : -1)));
        }
        onPrices({ id: list.id, name: list.name, tiers });
      })
      .catch(() => {
        if (!live) return;
        setCurrent(null);
        onPrices(null);
      });
    return () => {
      live = false;
    };
  }, [chosen, customerId, onPrices]);

  if (lists.length === 0) {
    return current ? (
      <p className="text-sm text-muted" role="status">
        {t("customerPrices", { name: current })}
      </p>
    ) : null;
  }
  return (
    <FormField id="sale-price-list" label={t("priceList")} hint={current && !chosen ? t("customerPrices", { name: current }) : undefined}>
      <select id="sale-price-list" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={chosen} onChange={(event) => onChosen(event.target.value)}>
        <option value="">{t("everydayPrices")}</option>
        {lists.map((list) => (
          <option key={list.id} value={list.id}>
            {list.name}
          </option>
        ))}
      </select>
    </FormField>
  );
}
