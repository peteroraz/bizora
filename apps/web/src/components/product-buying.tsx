"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, FormField, Input } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { formatCurrency, formatDay, formatWhen } from "../i18n/format";
import { can } from "../lib/access";
import { useAccess, usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import { problemOf } from "../lib/money-client";
import { useUnitName } from "./stock-quantity";

type SupplierLine = {
  supplierId: string;
  supplierName: string;
  supplierSku: string | null;
  preferred: boolean;
  leadTimeDays: number | null;
  minimumOrderQuantity: string | null;
  purchaseUnit: string | null;
  lastReceivedAt: string | null;
  lastCostMinor?: string | null;
};
type Buying = { lastPurchaseCostMinor?: string | null; lastLandedCostMinor?: string | null; lastPurchasedAt: string | null; suppliers: SupplierLine[] };
type ListPrice = { id: string; listName: string; listActive: boolean; unitCode: string; minQuantity: string; priceMinor: string; effectiveTo: string | null };

/**
 * Who sells this product to the shop, what it last cost, and its price-list prices (ADR-048). Costs show only to
 * people who may see cost prices; managers of purchases add suppliers and their codes here.
 */
export function ProductBuying({ productId, currency }: { productId: string; currency: string }) {
  const t = useTranslations("pricing.product");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const unitName = useUnitName();
  const managesBuying = can(access, Permission.PURCHASES_MANAGE);
  const seesLists = can(access, Permission.PRICING_LISTS_MANAGE, Permission.SALES_DISCOUNT);
  const [buying, setBuying] = useState<Buying | null>(null);
  const [prices, setPrices] = useState<ListPrice[]>([]);
  const [names, setNames] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [code, setCode] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const money = (minor: string) => formatCurrency(BigInt(minor), currency, locale);

  const load = useCallback(async () => {
    const [suppliers, lists] = await Promise.all([
      api(`/api/v1/products/${productId}/suppliers`).catch(() => null),
      seesLists ? api(`/api/v1/pricing/products/${productId}`).catch(() => null) : Promise.resolve(null),
    ]);
    if (suppliers?.ok) setBuying(((await suppliers.json()) as { data: Buying }).data);
    if (lists?.ok) setPrices(((await lists.json()) as { data: { prices: ListPrice[] } }).data.prices);
  }, [productId, seesLists]);

  useEffect(() => {
    void load();
    if (managesBuying) {
      void api("/api/v1/suppliers/names")
        .then(async (response) => (response.ok ? ((await response.json()) as { data: { items: { id: string; name: string }[] } }).data.items : []))
        .then(setNames)
        .catch(() => undefined);
    }
  }, [load, managesBuying]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!supplierId) return;
    setError(null);
    setPending(true);
    try {
      const response = await api(`/api/v1/suppliers/${supplierId}/products`, {
        method: "PUT",
        body: JSON.stringify({ productId, supplierSku: code.trim() || null, preferred }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      setBuying(((await response.json()) as { data: Buying }).data);
      setSupplierId("");
      setCode("");
      setPreferred(false);
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  async function makePreferred(line: SupplierLine) {
    const response = await api(`/api/v1/suppliers/${line.supplierId}/products`, { method: "PUT", body: JSON.stringify({ productId, preferred: true }) }).catch(() => null);
    if (response?.ok) setBuying(((await response.json()) as { data: Buying }).data);
  }

  if (!buying) return null;
  return (
    <Card data-testid="product-buying">
      <p className="text-sm font-medium">{t("title")}</p>
      {buying.lastPurchaseCostMinor ? (
        <p className="mt-2 text-sm">
          {buying.lastLandedCostMinor && buying.lastLandedCostMinor !== buying.lastPurchaseCostMinor
            ? t("lastCostLanded", { cost: money(buying.lastPurchaseCostMinor), landed: money(buying.lastLandedCostMinor) })
            : t("lastCost", { cost: money(buying.lastPurchaseCostMinor) })}
          {buying.lastPurchasedAt ? <span className="block text-muted">{t("lastBought", { when: formatWhen(buying.lastPurchasedAt, locale, place.timezone) })}</span> : null}
        </p>
      ) : null}
      {buying.suppliers.length === 0 ? <p className="mt-2 text-sm text-muted">{t("noSuppliers")}</p> : null}
      <ul className="mt-3 space-y-2 text-sm">
        {buying.suppliers.map((line) => (
          <li key={line.supplierId} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{line.preferred ? t("preferred", { name: line.supplierName }) : line.supplierName}</p>
              {line.supplierSku ? <p className="text-muted">{t("theirCode", { code: line.supplierSku })}</p> : null}
              {line.leadTimeDays !== null ? <p className="text-muted">{t("leadTime", { days: line.leadTimeDays })}</p> : null}
              {line.minimumOrderQuantity ? <p className="text-muted">{t("minimum", { quantity: line.minimumOrderQuantity, unit: unitName(line.purchaseUnit ?? "", 2) })}</p> : null}
            </div>
            <div className="text-right">
              {line.lastCostMinor ? <p className="tabular-nums">{money(line.lastCostMinor)}</p> : null}
              {managesBuying && !line.preferred ? (
                <Button type="button" variant="ghost" onClick={() => void makePreferred(line)}>
                  {t("makePreferred")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {managesBuying && names.length > 0 ? (
        <form className="mt-4 space-y-3" onSubmit={(event) => void add(event)}>
          <FormField id="buying-supplier" label={t("addSupplier")}>
            <select id="buying-supplier" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">{t("chooseSupplier")}</option>
              {names.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="buying-code" label={t("code")} hint={t("codeHint")}>
            <Input id="buying-code" value={code} maxLength={64} onChange={(event) => setCode(event.target.value)} />
          </FormField>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={preferred} onChange={(event) => setPreferred(event.target.checked)} />
            {t("usual")}
          </label>
          {error ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="outline" disabled={pending || !supplierId}>
            {t("saveSupplier")}
          </Button>
        </form>
      ) : null}
      {prices.length > 0 ? (
        <div className="mt-4">
          <p className="text-sm font-medium">{t("listPrices")}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {prices.map((price) => (
              <li key={price.id} className={`flex justify-between gap-3 ${price.listActive ? "" : "text-muted"}`}>
                <span>
                  {price.minQuantity === "1"
                    ? t("listEach", { list: price.listName, unit: unitName(price.unitCode, 1) })
                    : t("listFrom", { list: price.listName, quantity: price.minQuantity, unit: unitName(price.unitCode, 2) })}
                  {price.effectiveTo ? <span className="block text-muted">{t("until", { day: formatDay(price.effectiveTo, locale) })}</span> : null}
                </span>
                <span className="tabular-nums">{money(price.priceMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
