"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { PageHeader } from "@bizora/ui";
import Link from "next/link";
import { api } from "../../../../lib/api";
import { formatWhen } from "../../../../i18n/format";

type Item = { id: string; customerId: string; customerName: string; reason: string; dueAt: string; bucket: string };

const buckets = ["today", "overdue", "upcoming"] as const;

export default function FollowupsPage() {
  const t = useTranslations("followups");
  const locale = useLocale();
  const [items, setItems] = useState<Record<string, Item[]>>({ today: [], overdue: [], upcoming: [] });
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function load() {
    const [dashboard, ...lists] = await Promise.all([
      api("/api/v1/dashboard"),
      ...buckets.map((bucket) => api(`/api/v1/followups?bucket=${bucket}`)),
    ]);
    if (dashboard.ok) {
      const payload = await dashboard.json();
      setTimezone(payload.data?.timezone ?? "Africa/Lagos");
    }
    const next: Record<string, Item[]> = {};
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index] ?? "today";
      const response = lists[index];
      next[bucket] = response?.ok ? ((await response.json()).data?.items ?? []) : [];
    }
    setItems(next);
  }

  useEffect(() => {
    void load();
  }, []);

  async function update(id: string, body: Record<string, unknown>) {
    setPendingId(id);
    await api(`/api/v1/followups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    setPendingId(null);
    await load();
  }

  const labels = { today: t("dueToday"), overdue: t("overdue"), upcoming: t("upcoming") };

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} />
      {buckets.map((bucket) => (
        <section key={bucket} className="space-y-2">
          <h2 className="text-lg font-semibold">{labels[bucket]}</h2>
          {(items[bucket] ?? []).length === 0 ? <p className="text-sm text-muted">{t("empty")}</p> : null}
          <ul className="space-y-2">
            {(items[bucket] ?? []).map((item) => (
              <li key={item.id} className="rounded-card border border-border bg-card px-4 py-3 text-sm">
                <Link href={`/app/customers/${item.customerId}`} className="font-medium text-primary">
                  {item.customerName}
                </Link>
                <p>{item.reason}</p>
                <p className="text-muted">{formatWhen(item.dueAt, locale, timezone)}</p>
                <div className="mt-2 flex gap-3">
                  <button type="button" className="font-medium text-primary" disabled={pendingId === item.id} onClick={() => void update(item.id, { status: "done" })}>
                    {t("done")}
                  </button>
                  <button
                    type="button"
                    className="font-medium text-primary"
                    disabled={pendingId === item.id}
                    onClick={() => void update(item.id, { status: "snoozed", snoozeDays: 1 })}
                  >
                    {t("snooze")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
