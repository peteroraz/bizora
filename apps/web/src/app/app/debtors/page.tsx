"use client";

import { Permission } from "@bizora/contracts";
import { Badge, Card, EmptyState, FormField, Input, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../components/require-access";
import { formatCurrency, formatDay, formatPhone } from "../../../i18n/format";
import { api } from "../../../lib/api";

type Debtor = { customerId: string; name: string; phoneLast4: string | null; phone?: string | null; owingMinor: string; overdueMinor: string; oldestDueDate: string | null; openSales: number };
type Data = { currency: string; today: string; totals: { owingMinor: string; overdueMinor: string; debtors: number; overdueDebtors: number }; items: Debtor[]; page: number; pageSize: number };

function DebtorsScreen() {
  const t = useTranslations("debtors");
  const locale = useLocale();
  const [filter, setFilter] = useState<"all" | "overdue">("all");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async (nextFilter: "all" | "overdue", q: string) => {
    const params = new URLSearchParams({ filter: nextFilter });
    if (q.trim()) params.set("q", q.trim());
    try {
      const response = await api(`/api/v1/debtors?${params.toString()}`);
      if (response.ok) setData((await response.json()).data);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load("all", "");
  }, [load]);

  const money = (minor: string) => formatCurrency(BigInt(minor), data?.currency ?? "NGN", locale);
  /** "12 days late" once the oldest due date has passed, otherwise "due 5 Dec 2026". */
  const lateText = (due: string) => {
    const days = data ? Math.round((Date.parse(`${data.today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000) : 0;
    return days > 0 ? t("daysLate", { count: days }) : t("dueFrom", { date: formatDay(due, locale) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} />
      {offline ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {t("offline")}
        </p>
      ) : null}
      {data ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <p className="text-sm text-muted">{t("totalOwing")}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums" data-testid="debtors-total">
              {money(data.totals.owingMinor)}
            </p>
            <p className="text-sm text-muted">{t("debtorCount", { count: data.totals.debtors })}</p>
          </Card>
          <Card>
            <p className="text-sm text-muted">{t("overdue")}</p>
            <p className={`mt-1 text-xl font-semibold tabular-nums ${BigInt(data.totals.overdueMinor) > 0n ? "text-danger" : ""}`}>{money(data.totals.overdueMinor)}</p>
            <p className="text-sm text-muted">{t("debtorCount", { count: data.totals.overdueDebtors })}</p>
          </Card>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-2" role="tablist" aria-label={t("filter")}>
          {(["all", "overdue"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={filter === option}
              className={`rounded-pill border px-3 py-1 text-sm ${filter === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
              onClick={() => {
                setFilter(option);
                void load(option, query);
              }}
            >
              {t(`tab.${option}`)}
            </button>
          ))}
        </div>
        <FormField id="debtor-search" label={t("search")}>
          <Input
            id="debtor-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              void load(filter, event.target.value);
            }}
          />
        </FormField>
      </div>
      {data && data.items.length === 0 ? (
        <EmptyState title={filter === "overdue" ? t("emptyOverdue") : t("emptyTitle")} description={t("emptyBody")} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {data?.items.map((debtor) => (
            <li key={debtor.customerId}>
              <Link href={`/app/debtors/${debtor.customerId}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{debtor.name}</span>
                  <span className="block truncate text-sm text-muted">
                    {debtor.phone ? formatPhone(debtor.phone) : debtor.phoneLast4 ? t("phoneEnding", { last4: debtor.phoneLast4 }) : t("noPhone")}
                    {" · "}
                    {t("openSales", { count: debtor.openSales })}
                    {debtor.oldestDueDate ? ` · ${lateText(debtor.oldestDueDate)}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-sm font-medium tabular-nums">{money(debtor.owingMinor)}</span>
                  {BigInt(debtor.overdueMinor) > 0n ? <Badge tone="danger">{t("overdueAmount", { amount: money(debtor.overdueMinor) })}</Badge> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DebtorsPage() {
  return (
    <RequireAccess anyOf={[Permission.DEBTORS_READ]}>
      <DebtorsScreen />
    </RequireAccess>
  );
}
