"use client";

import { EmptyState, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatWhen } from "../../../i18n/format";
import { api } from "../../../lib/api";

type Notification = { id: string; kind: string; saleId: string | null; saleNumber: string | null; actorName: string | null; read: boolean; createdAt: string };

const KINDS = ["sale.paid", "sale.credit", "sale.released", "sale.comment", "sale.voided"];

export default function NotificationsPage() {
  const t = useTranslations("notifications");
  const locale = useLocale();
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
      <PageHeader title={t("title")} description={t("lead")} />
      {items && items.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyBody")} /> : null}
      {items && items.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((item) => {
            const text = KINDS.includes(item.kind)
              ? t(`kind.${item.kind.replace("sale.", "")}`, { number: item.saleNumber ?? "", name: item.actorName ?? t("someone") })
              : item.kind;
            return (
              <li key={item.id}>
                <Link href={item.saleId ? `/app/sales/${item.saleId}` : "/app"} className="flex items-start justify-between gap-3 px-4 py-3">
                  <span className={item.read ? "text-sm" : "text-sm font-semibold"}>{text}</span>
                  <span className="shrink-0 text-xs text-muted">{formatWhen(item.createdAt, locale, "Africa/Lagos")}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
