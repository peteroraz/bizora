"use client";

import { Permission } from "@bizora/contracts";
import { Card, PageHeader, Select } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { type BatchView, ExpiryBadge, useExpiryText } from "../../../../components/product-batches";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText } from "../../../../components/stock-quantity";
import { api } from "../../../../lib/api";

const WINDOWS = [7, 30, 90] as const;

/** Stock in this shop that is past its expiry date, or close to it (ADR-061), soonest first. */
function ExpiringScreen() {
  const t = useTranslations("batches");
  const stockText = useStockText();
  const expiry = useExpiryText();
  const [days, setDays] = useState<number>(30);
  const [items, setItems] = useState<BatchView[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const response = await api(`/api/v1/stock/expiring?days=${days}`).catch(() => null);
    if (!response?.ok) return setFailed(true);
    setItems((await response.json()).data.items);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("expiringTitle")} description={t("expiringLead")} actions={<BackLink href="/app/stock">{t("backToStock")}</BackLink>} />
      <div className="max-w-xs">
        <label htmlFor="expiring-days" className="text-sm font-medium">
          {t("within")}
        </label>
        <Select id="expiring-days" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
          {WINDOWS.map((window) => (
            <option key={window} value={window}>
              {t("withinDays", { days: window })}
            </option>
          ))}
        </Select>
      </div>
      {failed ? <p className="text-sm text-danger">{t("failed")}</p> : null}
      {items && items.length === 0 ? <p className="text-sm text-muted">{t("nothingExpiring", { days })}</p> : null}
      {items && items.length > 0 ? (
        <Card className="p-0">
          <ul className="divide-y divide-border text-sm">
            {items.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-testid="expiring-row">
                <a href={`/app/stock/${batch.productId}`} className="min-w-0">
                  <span className="block font-medium">{batch.productName}</span>
                  <span className="block text-muted">
                    {batch.batchNumber ?? t("noNumber")} · {expiry(batch)}
                  </span>
                </a>
                <span className="flex items-center gap-2">
                  <span className="font-medium tabular-nums">{stockText(batch.quantity, batch.baseUnit)}</span>
                  <ExpiryBadge status={batch.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

export default function ExpiringPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <ExpiringScreen />
    </RequireAccess>
  );
}
