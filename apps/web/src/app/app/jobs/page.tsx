"use client";

import { Permission } from "@bizora/contracts";
import { Badge, Card, Input, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActionLink } from "../../../components/action-link";
import { RequireAccess } from "../../../components/require-access";
import { formatCurrency, formatDay } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess, usePlace } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import type { JobListItem } from "../../../lib/jobs-client";

type Filter = "open" | "done" | "all";
const tone = { open: "warning", done: "success", cancelled: "neutral" } as const;

/** Jobs (ADR-035): work being done for customers, and what each still owes. */
function JobsScreen() {
  const t = useTranslations("jobs");
  const locale = useLocale();
  const access = useAccess();
  const { currency } = usePlace();
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<JobListItem[] | null>(null);

  const load = useCallback(async (next: Filter, search: string) => {
    const params = new URLSearchParams();
    if (next !== "all") params.set("status", next);
    if (search.trim()) params.set("q", search.trim());
    const response = await api(`/api/v1/jobs?${params.toString()}`).catch(() => null);
    setItems(response?.ok ? ((await response.json()).data.items as JobListItem[]) : []);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(filter, q), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [filter, q, load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        intro={t("lead")}
        actions={can(access, Permission.SALES_CREATE) ? <ActionLink href="/app/jobs/new" variant="primary">{t("new")}</ActionLink> : null}
      />
      <div className="flex flex-wrap items-center gap-2">
        {(["open", "done", "all"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            className={`min-h-11 rounded-control border px-4 text-sm font-medium ${filter === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
            onClick={() => setFilter(option)}
          >
            {t(`filters.${option}`)}
          </button>
        ))}
        <Input type="search" className="max-w-xs" value={q} placeholder={t("search")} aria-label={t("search")} onChange={(event) => setQ(event.target.value)} />
      </div>
      {items === null ? <p className="text-sm text-muted">{t("loading")}</p> : null}
      {items && items.length === 0 ? <p className="text-sm text-muted">{filter === "open" ? t("noneOpen") : t("none")}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {items?.map((item) => (
          <Link key={item.id} href={`/app/jobs/${item.id}`} className="block" data-testid="job-card">
            <Card className="space-y-1 hover:bg-sidebar">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">
                  {item.customer.name}
                  {item.title ? <span className="text-muted"> · {item.title}</span> : null}
                </p>
                <Badge tone={tone[item.status]}>{t(`status.${item.status}`)}</Badge>
              </div>
              <p className="text-sm text-muted">
                {item.number} · {formatDay(item.openedOn, locale)}
                {item.promisedOn && item.status === "open" ? ` · ${t("readyBy", { day: formatDay(item.promisedOn, locale) })}` : ""}
              </p>
              <p className="text-sm">
                {t("listMoney", { total: formatCurrency(BigInt(item.chargedMinor), currency, locale), left: formatCurrency(BigInt(item.leftMinor), currency, locale) })}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function JobsPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE, Permission.SALES_READ_ALL, Permission.SALES_READ_OWN]}>
      <JobsScreen />
    </RequireAccess>
  );
}
