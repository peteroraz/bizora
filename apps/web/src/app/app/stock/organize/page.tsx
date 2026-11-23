"use client";

import { Permission, parseAmount } from "@bizora/contracts";
import { Button, Card, EmptyState, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { useUnitName } from "../../../../components/stock-quantity";
import { RequireAccess } from "../../../../components/require-access";
import { formatCurrency } from "../../../../i18n/format";
import { api } from "../../../../lib/api";
import { usePlace } from "../../../../lib/access-context";

type Item = {
  id: string;
  name: string;
  unit: string;
  lastPriceMinor: string | null;
  timesSold: number;
  productId: string | null;
  catalogMode: string;
};

/** Items the shop has been selling, ready to add a cost or stock when the owner wants (ADR-049). */
function OrganizeScreen() {
  const t = useTranslations("stock");
  const locale = useLocale();
  const { currency } = usePlace();
  const unitName = useUnitName();
  const [items, setItems] = useState<Item[] | null>(null);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("/api/v1/saved-items")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()).data as { items: Item[] };
        setItems(data.items.filter((item) => !item.productId && item.catalogMode !== "managed"));
      })
      .catch(() => setItems([]));
  }, []);

  async function track(item: Item) {
    setError(null);
    setNote(null);
    const response = await api(`/api/v1/saved-items/${item.id}/upgrade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackStock: true }),
    }).catch(() => null);
    if (!response?.ok) {
      setError(t("organizeList.failed"));
      return;
    }
    setItems((current) => current?.filter((row) => row.id !== item.id) ?? []);
    setNote(t("organizeList.tracked"));
  }

  async function saveCost(item: Item) {
    setError(null);
    setNote(null);
    const amount = parseAmount(costs[item.id] ?? "", currency);
    if (amount === null) {
      setError(t("organizeList.failed"));
      return;
    }
    const year = new Date().getUTCFullYear();
    const response = await api(`/api/v1/saved-items/${item.id}/cost-estimate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        estimatedCostMinor: amount.toString(),
        periodStart: `${year}-01-01`,
        periodEnd: `${year}-12-31`,
        reason: t("organizeList.costReason"),
      }),
    }).catch(() => null);
    if (!response?.ok) {
      setError(t("organizeList.failed"));
      return;
    }
    setNote(t("organizeList.costSaved"));
  }

  const open = items?.filter((item) => !item.productId) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t("organizeList.title")} description={t("organizeList.lead")} actions={<BackLink href="/app/stock">{t("title")}</BackLink>} />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {note ? <p className="text-sm text-success">{note}</p> : null}
      {items && open.length === 0 ? <EmptyState title={t("organizeList.empty")} description={t("organizeList.lead")} /> : null}
      <ul className="space-y-3">
        {open.map((item) => (
          <li key={item.id}>
            <Card className="space-y-3">
              <div>
                <p className="font-medium">{item.name}</p>
                <p className="text-sm text-muted">
                  {t("organizeList.sales", { count: item.timesSold })}
                  {item.lastPriceMinor ? ` · ${formatCurrency(BigInt(item.lastPriceMinor), currency, locale)} / ${unitName(item.unit, 1)}` : ""}
                </p>
                <p className="text-sm text-muted">
                  {t("organizeList.noCost")} · {t("organizeList.noStock")}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block">{t("organizeList.cost")}</span>
                  <input
                    className="h-11 w-full rounded-control border border-border bg-input px-3"
                    inputMode="decimal"
                    value={costs[item.id] ?? ""}
                    onChange={(event) => setCosts((current) => ({ ...current, [item.id]: event.target.value }))}
                  />
                </label>
                <Button type="button" className="min-h-11" onClick={() => void saveCost(item)}>
                  {t("organizeList.saveCost")}
                </Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void track(item)}>
                  {t("organizeList.track")}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OrganizePage() {
  return (
    <RequireAccess anyOf={[Permission.CATALOG_MANAGE, Permission.CATALOG_CONVERT_TO_MANAGED, Permission.PRODUCTS_MANAGE]}>
      <OrganizeScreen />
    </RequireAccess>
  );
}
