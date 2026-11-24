"use client";

import { Badge, Card } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatCurrency, formatWhen } from "../i18n/format";
import { useAccess, usePlace } from "../lib/access-context";
import { dismissRejected, items, subscribe, type OutboxItem } from "../lib/offline/outbox";

/**
 * Sales saved on this phone that the server has not confirmed yet (ADR-040): waiting to sync, or refused and needing
 * a look. They are never shown as finished sales until the server accepts them; then they leave this list and appear
 * in the day's sales with their official number.
 */
export function WaitingSales() {
  const t = useTranslations("sales.waiting");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const [list, setList] = useState<OutboxItem[]>([]);

  useEffect(() => {
    const owner = access.owner;
    if (!owner) return;
    const load = () => void items(owner, "sale.create").then(setList).catch(() => setList([]));
    load();
    const stop = subscribe(load);
    return () => {
      stop();
    };
  }, [access.owner]);

  if (list.length === 0 || !access.owner) return null;
  const owner = access.owner;
  const refused = list.filter((item) => item.status === "rejected");
  return (
    <Card className="space-y-2" data-testid="waiting-sales">
      <p className="text-sm font-medium">{t("title", { count: list.length })}</p>
      <p className="text-xs text-muted">{t("lead")}</p>
      <ul className="divide-y divide-border text-sm">
        {list.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{item.meta?.summary ?? t("sale")}</span>
              <span className="block text-xs text-muted">
                {[item.meta?.number, item.meta?.customerName, formatWhen(item.occurredAt, locale, place.timezone), item.meta?.source === "voice" ? t("byVoice") : null].filter(Boolean).join(" · ")}
              </span>
              {item.status === "rejected" && item.error ? <span className="block text-xs text-danger">{item.error.message}</span> : null}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              {item.meta?.totalMinor ? <span className="tabular-nums">{formatCurrency(BigInt(item.meta.totalMinor), item.meta.currency, locale)}</span> : null}
              <Badge tone={item.status === "rejected" ? "danger" : "warning"}>{item.status === "rejected" ? t("needsReview") : t("pending")}</Badge>
            </span>
          </li>
        ))}
      </ul>
      {refused.some((item) => item.stored) ? (
        <button type="button" className="min-h-11 text-sm text-primary underline underline-offset-2" onClick={() => void dismissRejected(owner)}>
          {t("dismiss")}
        </button>
      ) : null}
    </Card>
  );
}
