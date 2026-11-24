"use client";

import { EmptyState, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatWhen } from "../../../i18n/format";
import { api } from "../../../lib/api";
import { usePlace } from "../../../lib/access-context";

type Notification = { id: string; kind: string; saleId: string | null; saleNumber: string | null; actorName: string | null; data?: { number?: string; summary?: string; reason?: string }; read: boolean; createdAt: string };

const KINDS = [
  "sale.paid",
  "sale.credit",
  "sale.released",
  "sale.comment",
  "sale.voided",
  "sale.below_price",
  "sale.credit_offline",
  "sale.closed_shop",
  "sale.typed_like_product",
  "transfer.waiting",
  "transfer.not_received",
  "stock.request",
  "stock.request_approved",
  "stock.request_rejected",
  "work.locked_offline",
  "work.after_hours_offline",
];
/** Where each notification opens: transfers to check go to the transfers (ADR-031), stock changes to Stock (ADR-034). */
const hrefOf = (item: Notification) =>
  item.kind === "transfer.waiting" ? "/app/money/transfers" : item.kind.startsWith("stock.") ? "/app/stock" : item.saleId ? `/app/sales/${item.saleId}` : "/app";
const keyOf = (item: Notification) => {
  if (item.kind === "sale.credit_offline") {
    const reason = item.data?.reason === "over_limit" || item.data?.reason === "both" ? item.data.reason : "not_approved";
    return `credit_offline_${reason}`;
  }
  return item.kind.startsWith("sale.") ? item.kind.slice(5) : item.kind.replace(".", "_");
};

export default function NotificationsPage() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const { timezone: timeZone } = usePlace();
  const [items, setItems] = useState<Notification[] | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api("/api/v1/notifications").catch(() => null);
      if (!response?.ok) {
        setItems([]);
        return;
      }
      const data = (await response.json()).data;
      setItems(data.items);
      if (data.unread > 0) {
        await api("/api/v1/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(() => null);
        window.dispatchEvent(new Event("bizora:notifications-read"));
      }
    })();
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} />
      {items && items.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyBody")} /> : null}
      {items && items.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((item) => {
            const text = KINDS.includes(item.kind)
              ? t(`kind.${keyOf(item)}`, { number: item.saleNumber ?? item.data?.number ?? "", name: item.actorName ?? t("someone"), summary: item.data?.summary ?? "" })
              : item.kind;
            return (
              <li key={item.id}>
                <Link href={hrefOf(item)} className="flex items-start justify-between gap-3 px-4 py-3">
                  <span className={item.read ? "text-sm" : "text-sm font-semibold"}>{text}</span>
                  <span className="shrink-0 text-xs text-muted">{formatWhen(item.createdAt, locale, timeZone)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
