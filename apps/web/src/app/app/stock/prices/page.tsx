"use client";

import { IDEMPOTENCY_HEADER, Permission, parseAmount, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { type FoundProduct, ProductFinder } from "../../../../components/product-finder";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { AmountInput, NameInput, QuantityInput } from "../../../../components/typing";
import { formatCurrency, formatDay } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";

type PriceList = { id: string; name: string; currency: string; active: boolean; staffCanChoose: boolean; prices: number };
type ListPrice = {
  id: string;
  productId: string;
  productName: string;
  unitCode: string;
  minQuantity: string;
  priceMinor: string;
  everydayPriceMinor: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

/**
 * Price lists (ADR-048): other prices for some customers or for buying many, such as wholesale. A product's own
 * price stays its everyday price. Prices already on sales never change.
 */
function PricesScreen() {
  const t = useTranslations("pricing");
  const locale = useLocale();
  const place = usePlace();
  const unitName = useUnitName();
  const [lists, setLists] = useState<PriceList[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [prices, setPrices] = useState<ListPrice[]>([]);
  const [name, setName] = useState("");
  const [staffChoose, setStaffChoose] = useState(false);
  const [product, setProduct] = useState<FoundProduct | null>(null);
  const [unit, setUnit] = useState("");
  const [fromQuantity, setFromQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const current = lists?.find((list) => list.id === selected) ?? null;
  const currency = current?.currency ?? place.currency;
  const money = (minor: string) => formatCurrency(BigInt(minor), currency, locale);

  const loadLists = useCallback(async () => {
    const response = await api("/api/v1/pricing/lists").catch(() => null);
    if (!response?.ok) return;
    const next = ((await response.json()) as { data: { lists: PriceList[] } }).data.lists;
    setLists(next);
    setSelected((was) => was ?? next[0]?.id ?? null);
  }, []);

  const loadPrices = useCallback(async (id: string) => {
    const response = await api(`/api/v1/pricing/lists/${id}/prices`).catch(() => null);
    if (response?.ok) setPrices(((await response.json()) as { data: { prices: ListPrice[] } }).data.prices);
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (selected) void loadPrices(selected);
    else setPrices([]);
  }, [selected, loadPrices]);

  async function send(path: string, method: string, body?: unknown) {
    setError(null);
    setNotice(null);
    setPending(true);
    const key = uuidv7();
    try {
      const response = await api(path, { method, headers: { [IDEMPOTENCY_HEADER]: key }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return null;
      }
      return (await response.json()) as { data: unknown };
    } catch {
      setError(t("failed"));
      return null;
    } finally {
      setPending(false);
    }
  }

  async function addList(event: React.FormEvent) {
    event.preventDefault();
    const saved = await send("/api/v1/pricing/lists", "POST", { name: name.trim(), staffCanChoose: staffChoose });
    if (!saved) return;
    const list = saved.data as PriceList;
    setName("");
    setStaffChoose(false);
    setNotice(t("listAdded", { name: list.name }));
    setSelected(list.id);
    await loadLists();
  }

  async function change(changes: Partial<Pick<PriceList, "active" | "staffCanChoose">>) {
    if (!current) return;
    if (await send(`/api/v1/pricing/lists/${current.id}`, "PATCH", changes)) {
      setNotice(t("listSaved"));
      await loadLists();
    }
  }

  async function addPrice(event: React.FormEvent) {
    event.preventDefault();
    if (!current || !product) return;
    const amount = parseAmount(price, currency);
    if (amount === null) {
      setError(t("badPrice"));
      return;
    }
    const saved = await send(`/api/v1/pricing/lists/${current.id}/prices`, "PUT", {
      prices: [
        {
          productId: product.id,
          unitCode: unit || product.baseUnit,
          minQuantity: fromQuantity.trim() || "1",
          priceMinor: amount.toString(),
          ...(starts ? { effectiveFrom: starts } : {}),
          ...(ends ? { effectiveTo: ends } : {}),
        },
      ],
    });
    if (!saved) return;
    setNotice(t("priceSaved", { name: product.name }));
    setProduct(null);
    setPrice("");
    setFromQuantity("1");
    setStarts("");
    setEnds("");
    await Promise.all([loadPrices(current.id), loadLists()]);
  }

  async function removePrice(item: ListPrice) {
    if (!current) return;
    if (await send(`/api/v1/pricing/lists/${current.id}/prices/${item.id}`, "DELETE")) {
      setNotice(t("priceRemoved", { name: item.productName }));
      await Promise.all([loadPrices(current.id), loadLists()]);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} actions={<BackLink href="/app/stock">{t("back")}</BackLink>} />
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Card>
        <form className="space-y-4" onSubmit={(event) => void addList(event)}>
          <FormField id="list-name" label={t("newList")} hint={t("newListHint")}>
            <NameInput id="list-name" value={name} maxLength={60} required onChange={(event) => setName(event.target.value)} />
          </FormField>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={staffChoose} onChange={(event) => setStaffChoose(event.target.checked)} />
            {t("staffCanChoose")}
          </label>
          <Button type="submit" disabled={pending || !name.trim()}>
            {t("addList")}
          </Button>
        </form>
      </Card>
      {lists && lists.length === 0 ? <p className="text-sm text-muted">{t("noLists")}</p> : null}
      {lists && lists.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("lists")}>
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              role="tab"
              aria-selected={list.id === selected}
              className={`min-h-11 rounded-control border px-4 text-sm font-medium ${list.id === selected ? "border-primary bg-primary text-primary-fg" : "border-border"} ${list.active ? "" : "opacity-60"}`}
              onClick={() => setSelected(list.id)}
            >
              {list.active ? list.name : t("listOff", { name: list.name })}
            </button>
          ))}
        </div>
      ) : null}
      {current ? (
        <section className="space-y-4" aria-labelledby="list-heading">
          <h2 id="list-heading" className="text-lg font-semibold">
            {current.name}
          </h2>
          <div className="flex flex-wrap gap-4">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={current.active} disabled={pending} onChange={(event) => void change({ active: event.target.checked })} />
              {t("inUse")}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={current.staffCanChoose} disabled={pending} onChange={(event) => void change({ staffCanChoose: event.target.checked })} />
              {t("staffCanChoose")}
            </label>
          </div>
          <Card>
            <form className="space-y-4" onSubmit={(event) => void addPrice(event)}>
              <p className="text-sm font-medium">{t("addPrice")}</p>
              {product ? (
                <p className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{product.name}</span>
                  <Button type="button" variant="ghost" onClick={() => setProduct(null)}>
                    {t("change")}
                  </Button>
                </p>
              ) : (
                <ProductFinder
                  id="price-product"
                  onPick={(picked) => {
                    setProduct(picked);
                    setUnit(picked.baseUnit);
                  }}
                />
              )}
              {product ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <FormField id="price-unit" label={t("unit")}>
                      <select id="price-unit" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={unit} onChange={(event) => setUnit(event.target.value)}>
                        {[product.baseUnit, ...product.packs.map((pack) => pack.unitCode)].map((code) => (
                          <option key={code} value={code}>
                            {unitName(code, 1)}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <FormField id="price-from" label={t("fromQuantity")} hint={t("fromQuantityHint")}>
                      <QuantityInput id="price-from" value={fromQuantity} onChange={(event) => setFromQuantity(event.target.value)} />
                    </FormField>
                    <FormField id="price-amount" label={t("price")}>
                      <AmountInput id="price-amount" currency={currency} value={price} required onChange={(event) => setPrice(event.target.value)} />
                    </FormField>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField id="price-starts" label={t("starts")} hint={t("optional")}>
                      <input id="price-starts" type="date" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={starts} onChange={(event) => setStarts(event.target.value)} />
                    </FormField>
                    <FormField id="price-ends" label={t("ends")} hint={t("optional")}>
                      <input id="price-ends" type="date" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={ends} onChange={(event) => setEnds(event.target.value)} />
                    </FormField>
                  </div>
                  <Button type="submit" disabled={pending || !price.trim()}>
                    {t("savePrice")}
                  </Button>
                </>
              ) : null}
            </form>
          </Card>
          {prices.length === 0 ? <p className="text-sm text-muted">{t("noPrices")}</p> : null}
          <ul className="space-y-2" data-testid="list-prices">
            {prices.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 rounded-card border border-border bg-surface p-4">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-muted">
                    {item.minQuantity === "1" ? t("each", { unit: unitName(item.unitCode, 1) }) : t("fromMany", { quantity: item.minQuantity, unit: unitName(item.unitCode, 2) })}
                  </p>
                  {item.everydayPriceMinor ? <p className="text-muted">{t("everyday", { price: money(item.everydayPriceMinor) })}</p> : null}
                  {item.effectiveFrom || item.effectiveTo ? (
                    <p className="text-muted">
                      {item.effectiveFrom && item.effectiveTo
                        ? t("between", { from: formatDay(item.effectiveFrom, locale), to: formatDay(item.effectiveTo, locale) })
                        : item.effectiveFrom
                          ? t("fromDay", { day: formatDay(item.effectiveFrom, locale) })
                          : t("untilDay", { day: formatDay(item.effectiveTo ?? "", locale) })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <p className="font-semibold tabular-nums">{money(item.priceMinor)}</p>
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => void removePrice(item)}>
                    {t("remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function PricesPage() {
  return (
    <RequireAccess anyOf={[Permission.PRICING_LISTS_MANAGE]}>
      <PricesScreen />
    </RequireAccess>
  );
}
