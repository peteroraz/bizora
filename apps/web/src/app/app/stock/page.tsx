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
import { useAccess } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import { readCatalog, searchCatalog } from "../../../lib/offline/catalog";
import { isNetworkFailure } from "../../../lib/offline/sync";
import { type ProductView, refreshOfflineCatalog } from "../../../lib/stock-client";

type PendingCount = {
  id: string;
  productName: string;
  baseUnit: string;
  branchName: string;
  countedByName: string | null;
  countedQuantity: string;
  systemQuantity: string;
};
type BelowZero = { productId: string; name: string; baseUnit: string; branchName: string; quantity: string };

function StockScreen() {
  const t = useTranslations("stock");
  const common = useTranslations("common");
  const locale = useLocale();
  const access = useAccess();
  const stockText = useStockText();
  const unitName = useUnitName();
  const canAdd = can(access, Permission.PRODUCTS_MANAGE);
  const canReceive = can(access, Permission.STOCK_RECEIVE);
  const canApprove = can(access, Permission.STOCK_ADJUST);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [items, setItems] = useState<ProductView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState("NGN");
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

  async function decide(id: string, decision: "approve" | "reject") {
    await api(`/api/v1/stock/counts/${id}/${decision}`, { method: "POST" });
    await Promise.all([loadChecks(), load(query, page)]);
  }

  const pages = Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canAdd || canReceive ? (
            <div className="flex flex-wrap gap-4">
              {canReceive ? (
                <Link href="/app/stock/receive" className="text-sm font-medium text-primary">
                  {t("delivery")}
                </Link>
              ) : null}
              {canAdd ? (
                <>
                  <Link href="/app/stock/import" className="text-sm font-medium text-primary">
                    {t("import")}
                  </Link>
                  <Link href="/app/stock/new" className="text-sm font-medium text-primary">
                    {t("add")}
                  </Link>
                </>
              ) : null}
            </div>
          ) : undefined
        }
      />
      {offlineSince !== undefined ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {offlineSince ? t("offline", { when: formatWhen(offlineSince, locale, "Africa/Lagos") }) : t("offlineNever")}
        </p>
      ) : null}
      {counts.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("pendingTitle")}</p>
          <ul className="mt-3 space-y-3 text-sm">
            {counts.map((count) => (
              <li key={count.id} className="flex flex-wrap items-center gap-3">
                <span className="flex-1">
                  {t("pendingLine", {
                    name: count.productName,
                    shop: count.branchName,
                    counted: stockText(count.countedQuantity, count.baseUnit),
                    system: stockText(count.systemQuantity, count.baseUnit),
                    by: count.countedByName ?? "",
                  })}
                </span>
                <Button size="sm" onClick={() => void decide(count.id, "approve")}>
                  {t("approve")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void decide(count.id, "reject")}>
                  {t("reject")}
                </Button>
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
                <span className="min-w-0">
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
