"use client";

import { Permission, PRODUCT_PAGE_SIZE } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../components/require-access";
import { useStockText, useUnitName } from "../../../components/stock-quantity";
import { formatCurrency, formatWhen } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess, usePlace } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import { readCatalog, searchCatalog } from "../../../lib/offline/catalog";
import { isNetworkFailure } from "../../../lib/offline/sync";
import { type ProductView, refreshOfflineCatalog } from "../../../lib/stock-client";
import { ActionLink } from "../../../components/action-link";
import { StockRequests } from "../../../components/stock-requests";

type PendingCount = {
  id: string;
  productName: string;
  baseUnit: string;
  branchName: string;
  countedByName: string | null;
  countedQuantity: string;
  systemQuantity: string;
  note: string | null;
};
type BelowZero = { productId: string; name: string; baseUnit: string; branchName: string; quantity: string };

/** Added up by the server for everything the search matches, in this shop (Sprint 7a). */
type StockTotals = { products: number; inStock: number; sellingValueMinor: string; withoutPrice: number; costValueMinor?: string };

/** The same sums from the copy kept on the phone, when there is no network. Cost is not kept on the phone. */
function totalsOf(items: { quantity: string; priceMinor: string | null; trackStock: boolean }[]): StockTotals {
  let selling = 0n;
  let inStock = 0;
  let withoutPrice = 0;
  for (const item of items) {
    const held = BigInt(item.quantity);
    if (!item.trackStock || held <= 0n) continue;
    inStock += 1;
    if (item.priceMinor === null) withoutPrice += 1;
    else selling += held * BigInt(item.priceMinor);
  }
  return { products: items.length, inStock, sellingValueMinor: ((selling + 500n) / 1000n).toString(), withoutPrice };
}

function StockScreen() {
  const t = useTranslations("stock");
  const common = useTranslations("common");
  const batchText = useTranslations("batches");
  const locale = useLocale();
  const access = useAccess();
  const stockText = useStockText();
  const unitName = useUnitName();
  const canAdd = can(access, Permission.PRODUCTS_MANAGE);
  const canReceive = can(access, Permission.STOCK_RECEIVE);
  const canApprove = can(access, Permission.STOCK_ADJUST);
  const canLists = can(access, Permission.STOCK_COUNT, Permission.STOCK_ADJUST, Permission.STOCK_TRANSFER);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [items, setItems] = useState<ProductView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const place = usePlace();
  const [currency, setCurrency] = useState(place.currency);
  const [totals, setTotals] = useState<StockTotals | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [offlineSince, setOfflineSince] = useState<string | null | undefined>(undefined);
  const [counts, setCounts] = useState<PendingCount[]>([]);
  const [belowZero, setBelowZero] = useState<BelowZero[]>([]);

  const loadOffline = useCallback(
    async (needle: string) => {
      const catalog = access.owner && access.branchId ? await readCatalog(access.owner.tenantId, access.branchId).catch(() => null) : null;
      setOfflineSince(catalog?.syncedAt ?? null);
      if (!catalog) {
        setItems([]);
        setTotal(0);
        return;
      }
      const found = searchCatalog(catalog, needle).filter((item) => !category || item.category === category);
      setCurrency(catalog.currency);
      setItems(found.map((item) => ({ ...item, stock: { quantity: item.quantity, belowZero: BigInt(item.quantity) < 0n } })));
      setTotal(found.length);
      setTotals(totalsOf(found.map((item) => ({ quantity: item.quantity, priceMinor: item.priceMinor, trackStock: item.trackStock }))));
    },
    [access.owner, access.branchId, category],
  );

  const load = useCallback(
    async (needle: string, nextPage: number) => {
      setPending(true);
      try {
        const params = new URLSearchParams({ page: String(nextPage) });
        if (needle.trim()) params.set("q", needle.trim());
        if (category) params.set("category", category);
        const response = await api(`/api/v1/products?${params.toString()}`);
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()).data;
        setItems(data.items);
        setTotal(data.total);
        setPage(data.page);
        setCategories(data.categories);
        setCurrency(data.currency);
        setTotals(data.totals ?? null);
        setOfflineSince(undefined);
        void refreshOfflineCatalog(access.owner?.tenantId, data.branchId);
      } catch (error) {
        if (isNetworkFailure(error)) await loadOffline(needle);
      } finally {
        setPending(false);
        setLoaded(true);
      }
    },
    [category, access.owner?.tenantId, loadOffline],
  );

  const loadChecks = useCallback(async () => {
    if (!canApprove) return;
    try {
      const [countResponse, zeroResponse] = await Promise.all([api("/api/v1/stock/counts"), api("/api/v1/stock/below-zero")]);
      if (countResponse.ok) setCounts((await countResponse.json()).data.items);
      if (zeroResponse.ok) setBelowZero((await zeroResponse.json()).data.items);
    } catch {
      // Offline: nothing to approve until the network is back.
    }
  }, [canApprove]);

  useEffect(() => {
    void load("", 1);
    void loadChecks();
  }, [load, loadChecks]);

  // Stock past its expiry date or close to it (ADR-061). Nothing shows for a business that keeps no batches.
  const [expiring, setExpiring] = useState<{ expired: number; soon: number } | null>(null);
  useEffect(() => {
    void api("/api/v1/stock/expiring")
      .then(async (response) => (response.ok ? setExpiring((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, []);

  // What the approver says about each count (7f): optional to approve, needed to reject.
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [decisionError, setDecisionError] = useState<Record<string, string>>({});

  async function decide(id: string, decision: "approve" | "reject") {
    const note = (decisionNotes[id] ?? "").trim();
    if (decision === "reject" && note.length < 3) {
      setDecisionError((current) => ({ ...current, [id]: t("rejectNeedsReason") }));
      return;
    }
    setDecisionError((current) => ({ ...current, [id]: "" }));
    const response = await api(`/api/v1/stock/counts/${id}/${decision}`, { method: "POST", body: JSON.stringify(note ? { note } : {}) }).catch(() => null);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => null) : null;
      setDecisionError((current) => ({ ...current, [id]: payload?.error?.message ?? t("failed") }));
      return;
    }
    await Promise.all([loadChecks(), load(query, page)]);
  }

  const pages = Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        intro={t("description")}
        actions={
          canAdd || canReceive || canLists ? (
            <>
              {canLists ? <ActionLink href="/app/stock/lists">{t("lists")}</ActionLink> : null}
              {can(access, Permission.STOCK_TRANSFER) ? <ActionLink href="/app/stock/transfers">{t("transfersLink")}</ActionLink> : null}
              {can(access, Permission.STOCK_COUNT, Permission.STOCK_ADJUST) ? <ActionLink href="/app/stock/counts">{t("countsLink")}</ActionLink> : null}
              {canReceive ? (
                <ActionLink href="/app/stock/receive" variant={canAdd ? "outline" : "primary"}>
                  {t("delivery")}
                </ActionLink>
              ) : null}
              {canAdd ? (
                <>
                  <ActionLink href="/app/stock/categories">{t("categoriesLink")}</ActionLink>
                  <ActionLink href="/app/stock/attributes">{t("attributesLink")}</ActionLink>
                  <ActionLink href="/app/stock/import">{t("import")}</ActionLink>
                  <ActionLink href="/app/stock/names">{t("names")}</ActionLink>
                  <ActionLink href="/app/stock/organize">{t("organize")}</ActionLink>
                  <ActionLink href="/app/stock/new" variant="primary">
                    {t("add")}
                  </ActionLink>
                </>
              ) : null}
              {can(access, Permission.PRICING_LISTS_MANAGE) ? <ActionLink href="/app/stock/prices">{t("pricesLink")}</ActionLink> : null}
              {canReceive && can(access, Permission.PURCHASES_MANAGE) ? <ActionLink href="/app/stock/delivery">{t("deliveryChargesLink")}</ActionLink> : null}
            </>
          ) : undefined
        }
      />
      {offlineSince !== undefined ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {offlineSince ? t("offline", { when: formatWhen(offlineSince, locale, Intl.DateTimeFormat().resolvedOptions().timeZone) }) : t("offlineNever")}
        </p>
      ) : null}
      {expiring && expiring.expired + expiring.soon > 0 ? (
        <a
          href="/app/stock/expiring"
          className={`block rounded-card border px-4 py-3 text-sm ${expiring.expired > 0 ? "border-danger bg-danger-bg text-danger" : "border-warning bg-warning-bg text-warning"}`}
          data-testid="expiring-notice"
        >
          {batchText("notice", { expired: expiring.expired, soon: expiring.soon })}
        </a>
      ) : null}
      {totals && totals.products > 0 ? (
        <Card className="p-4" data-testid="stock-totals">
          <dl className="grid gap-4 sm:grid-cols-3">
            {totals.costValueMinor !== undefined ? (
              <div>
                <dt className="text-sm text-muted">{t("totals.cost")}</dt>
                <dd className="text-xl font-semibold tabular-nums" data-testid="stock-cost-value">
                  {formatCurrency(BigInt(totals.costValueMinor), currency, locale)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-sm text-muted">{t("totals.selling")}</dt>
              <dd className="text-xl font-semibold tabular-nums" data-testid="stock-selling-value">
                {formatCurrency(BigInt(totals.sellingValueMinor), currency, locale)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("totals.inStock")}</dt>
              <dd className="text-xl font-semibold tabular-nums">{t("totals.inStockValue", { inStock: totals.inStock, products: totals.products })}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted">
            {query.trim() || category ? t("totals.forSearch") : t("totals.forShop")}
            {totals.withoutPrice > 0 ? ` ${t("totals.withoutPrice", { count: totals.withoutPrice })}` : ""}
          </p>
        </Card>
      ) : null}
      <StockRequests onDecided={() => void load(query, page)} />
      {counts.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("pendingTitle")}</p>
          <ul className="mt-3 space-y-3 text-sm">
            {counts.map((count) => (
              <li key={count.id} className="space-y-2 rounded-md border border-border p-3" data-testid="pending-count">
                <p>
                  {t("pendingLine", {
                    name: count.productName,
                    shop: count.branchName,
                    counted: stockText(count.countedQuantity, count.baseUnit),
                    system: stockText(count.systemQuantity, count.baseUnit),
                    by: count.countedByName ?? "",
                  })}
                </p>
                {count.note ? <p className="text-muted">{t("countNoteLine", { note: count.note })}</p> : null}
                <FormField id={`decision-${count.id}`} label={t("decisionNote")} hint={t("decisionNoteHint")} error={decisionError[count.id] || undefined}>
                  <Input
                    id={`decision-${count.id}`}
                    maxLength={240}
                    value={decisionNotes[count.id] ?? ""}
                    onChange={(event) => setDecisionNotes((current) => ({ ...current, [count.id]: event.target.value }))}
                  />
                </FormField>
                <div className="flex flex-wrap gap-3">
                  <Button size="sm" onClick={() => void decide(count.id, "approve")}>
                    {t("approve")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void decide(count.id, "reject")}>
                    {t("reject")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {belowZero.length > 0 ? (
        <Card>
          <p className="text-sm font-medium text-danger">{t("belowZeroTitle")}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {belowZero.map((item) => (
              <li key={`${item.productId}-${item.branchName}`}>
                <Link href={`/app/stock/${item.productId}`} className="text-primary">
                  {t("belowZeroLine", { name: item.name, shop: item.branchName, quantity: stockText(item.quantity, item.baseUnit) })}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <SafeForm
        className="flex flex-wrap items-end gap-3"
        pending={pending}
        onSubmit={() => {
          void load(query, 1);
        }}
      >
        <FormField id="stock-search" label={t("searchLabel")}>
          <Input id="stock-search" value={query} placeholder={t("searchPlaceholder")} onChange={(event) => setQuery(event.target.value)} />
        </FormField>
        {categories.length > 0 ? (
          <FormField id="stock-category" label={t("category")}>
            <Select id="stock-category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">{t("allCategories")}</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        <SubmitButton pending={pending} pendingLabel={common("loading")}>
          {t("search")}
        </SubmitButton>
      </SafeForm>
      {loaded && items.length === 0 ? (
        <EmptyState title={query.trim() ? t("noResults") : t("emptyTitle")} description={query.trim() ? t("description") : t("emptyBody")} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((product) => (
            <li key={product.id}>
              <Link href={`/app/stock/${product.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                {product.photoUrl ? <img src={product.photoUrl} alt="" className="h-11 w-11 shrink-0 rounded-md border border-border object-cover" loading="lazy" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{product.name}</span>
                  <span className="block text-sm text-muted">
                    {product.priceMinor
                      ? t("price", { price: formatCurrency(BigInt(product.priceMinor), currency, locale), unit: unitName(product.baseUnit, 1) })
                      : (product.category ?? "")}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 text-right">
                  <span className="text-sm font-medium">
                    {product.trackStock ? stockText(product.stock.quantity, product.baseUnit, product.packs) : t("notTracked")}
                  </span>
                  {product.stock.belowZero ? (
                    <Badge tone="danger">{t("belowZero")}</Badge>
                  ) : product.stock.low ? (
                    <Badge tone="warning">{t("low")}</Badge>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > PRODUCT_PAGE_SIZE && offlineSince === undefined ? (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="font-medium text-primary" disabled={page <= 1} onClick={() => void load(query, page - 1)}>
            {t("previous")}
          </button>
          <span>{t("page", { page })}</span>
          <button type="button" className="font-medium text-primary" disabled={page >= pages} onClick={() => void load(query, page + 1)}>
            {t("next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function StockPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <StockScreen />
    </RequireAccess>
  );
}
