"use client";

import { Permission } from "@bizora/contracts";
import { Badge, Card, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText } from "../../../../components/stock-quantity";
import { formatCurrency } from "../../../../i18n/format";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Item = {
  productId: string;
  name: string;
  baseUnit: string;
  onHand: string;
  incoming: string;
  reorderPoint: string;
  targetQuantity: string | null;
  belowMinimum: boolean;
  toOrder: string | null;
  leadTimeDays: number | null;
  supplierId: string | null;
  supplierName: string | null;
  estimatedCostMinor?: string | null;
};

/** What to buy for this shop (ADR-063): products at or below their reorder point, grouped by the usual supplier. */
function ToBuyScreen() {
  const t = useTranslations("reorder");
  const locale = useLocale();
  const { currency } = usePlace();
  const access = useAccess();
  const stockText = useStockText();
  const [data, setData] = useState<{ branchName: string; items: Item[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api("/api/v1/stock/to-buy")
      .then(async (response) => (response.ok ? setData((await response.json()).data) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [access.branchId]);

  const groups = new Map<string, Item[]>();
  for (const item of data?.items ?? []) groups.set(item.supplierName ?? "", [...(groups.get(item.supplierName ?? "") ?? []), item]);
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);

  return (
    <div className="space-y-6">
      <PageHeader title={t("toBuyTitle")} description={data ? t("toBuyLead", { shop: data.branchName }) : undefined} actions={<BackLink href="/app/stock">{t("backToStock")}</BackLink>} />
      {failed ? <p className="text-sm text-danger">{t("failed")}</p> : null}
      {data && data.items.length === 0 ? <p className="text-sm text-muted">{t("nothingToBuy")}</p> : null}
      {[...groups.entries()].map(([supplier, items]) => {
        const costs = items.map((item) => item.estimatedCostMinor).filter((value): value is string => Boolean(value));
        const total = costs.reduce((sum, value) => sum + BigInt(value), 0n);
        return (
          <Card key={supplier || "none"} className="p-0" data-testid="to-buy-group">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
              <p className="font-medium">{supplier || t("noSupplier")}</p>
              {costs.length > 0 ? <p className="text-sm text-muted">{t("about", { amount: money(total) })}</p> : null}
            </div>
            <ul className="divide-y divide-border text-sm">
              {items.map((item) => (
                <li key={item.productId} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3" data-testid="to-buy-row">
                  <a href={`/app/stock/${item.productId}`} className="min-w-0">
                    <span className="block font-medium">{item.name}</span>
                    <span className="block text-muted">
                      {t("left", { quantity: stockText(item.onHand, item.baseUnit), point: stockText(item.reorderPoint, item.baseUnit) })}
                      {item.incoming !== "0" ? ` · ${t("onTheWay", { quantity: stockText(item.incoming, item.baseUnit) })}` : ""}
                      {item.leadTimeDays !== null ? ` · ${t("takesDays", { days: item.leadTimeDays })}` : ""}
                    </span>
                  </a>
                  <span className="flex items-center gap-2 text-right">
                    {item.belowMinimum ? <Badge tone="danger">{t("belowMinimum")}</Badge> : null}
                    <span className="font-semibold tabular-nums">
                      {item.toOrder === null ? t("setTarget") : item.toOrder === "0" ? t("covered") : t("buy", { quantity: stockText(item.toOrder, item.baseUnit) })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

export default function ToBuyPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <ToBuyScreen />
    </RequireAccess>
  );
}
