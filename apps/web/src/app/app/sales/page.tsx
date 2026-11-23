"use client";

import { Permission, SALE_PAGE_SIZE } from "@bizora/contracts";
import { Badge, Card, EmptyState, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { DaySwitcher, dayFromAddress } from "../../../components/day-switcher";
import { RequireAccess } from "../../../components/require-access";
import { formatCurrency, formatWhen } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess, usePlace } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import type { SaleReleaseRow, SaleSummary, SaleView } from "../../../lib/sales-client";
import { ActionLink } from "../../../components/action-link";
import { WaitingSales } from "../../../components/waiting-sales";
import { useUnitName } from "../../../components/stock-quantity";

type Tab = "day" | "awaiting_payment" | "awaiting_release";

/** Keeps the chosen day in the address, so a reload or a shared link opens the same day. */
function showDayInAddress(day: string | null) {
  const url = new URL(window.location.href);
  if (day) url.searchParams.set("day", day);
  else url.searchParams.delete("day");
  window.history.replaceState(window.history.state, "", url);
}

function SalesScreen() {
  const t = useTranslations("sales");
  const locale = useLocale();
  const { timezone: timeZone } = usePlace();
  const access = useAccess();
  const canSell = can(access, Permission.SALES_CREATE);
  const desk = access.salesFlow === "desk";
  const all = can(access, Permission.SALES_READ_ALL);
  const seesDay = can(access, Permission.SALES_READ_OWN, Permission.SALES_READ_ALL);
  // Desk flow: the cashier and the store keeper each start on their own waiting list.
  const tabs: Tab[] = [
    ...(desk && (all || can(access, Permission.SALES_COLLECT)) ? (["awaiting_payment"] as const) : []),
    ...(desk && (all || can(access, Permission.SALES_RELEASE)) ? (["awaiting_release"] as const) : []),
    ...(seesDay ? (["day"] as const) : []),
  ];
  const defaultTab: Tab = all || !desk ? "day" : (tabs[0] ?? "day");
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [date, setDate] = useState("");
  // The business's own today, from the first load (not the phone's clock).
  const [today, setToday] = useState("");
  const [items, setItems] = useState<(SaleView | SaleReleaseRow)[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<SaleSummary | null>(null);
  type TopRow = { name: string; unit: string; totalMinor: string; salesCount: number; costKnown: boolean };
  const [top, setTop] = useState<TopRow[]>([]);
  const unitName = useUnitName();
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async function load(day: string, nextPage: number, view: Tab): Promise<void> {
    const params = new URLSearchParams({ page: String(nextPage) });
    if (view !== "day") params.set("status", view);
    else if (day) params.set("date", day);
    try {
      const [list, totals] = await Promise.all([
        api(`/api/v1/sales?${params.toString()}`),
        view === "day" && seesDay ? api(`/api/v1/sales/summary${day ? `?date=${day}` : ""}`) : Promise.resolve(null),
      ]);
      if (list.ok) {
        const data = (await list.json()).data;
        setItems(data.items);
        setTotal(data.total);
        setPage(data.page);
      }
      if (totals?.ok) {
        const data = (await totals.json()).data as SaleSummary;
        setSummary(data);
        if (!day) {
          setDate(data.date);
          setToday(data.date);
          // A link or a reload that named a day (?day=2026-11-03) opens on that day.
          const asked = dayFromAddress(new URLSearchParams(window.location.search).get("day"), data.date);
          if (asked && asked !== data.date) {
            setDate(asked);
            void load(asked, 1, "day");
          }
        }
      } else if (view !== "day") {
        setSummary(null);
      }
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoaded(true);
    }
  }, [seesDay]);

  useEffect(() => {
    void load("", 1, defaultTab);
  }, [load, defaultTab]);

  useEffect(() => {
    if (tab !== "day" || !seesDay || !date) return;
    void api(`/api/v1/sales/top-items?from=${date}&to=${date}`)
      .then(async (response) => {
        if (response.ok) setTop(((await response.json()).data as { items: TopRow[] }).items);
      })
      .catch(() => undefined);
  }, [tab, seesDay, date]);

  const currency = summary?.currency ?? "NGN";
  const money = (minor: string) => formatCurrency(BigInt(minor), currency, locale);
  const pages = Math.max(1, Math.ceil(total / SALE_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        intro={tab !== "day" ? t(`tabLead.${tab}`) : summary?.mine ? t("mineLead") : t("lead")}
        actions={
          canSell ? (
            <>
              <ActionLink href="/app/sales/import">{t("import")}</ActionLink>
              <ActionLink href="/app/sales/new?voice=1" data-testid="sales-voice">
                {t("voice.open")}
              </ActionLink>
              <ActionLink href="/app/sales/new" variant="primary">
                {t("new")}
              </ActionLink>
            </>
          ) : undefined
        }
      />
      <WaitingSales />
      {offline ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {t("listOffline")}
        </p>
      ) : null}
      {tabs.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("lists")}>
          {tabs.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tab === option}
              className={`rounded-pill border px-3 py-1 text-sm ${tab === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
              onClick={() => {
                setTab(option);
                void load(date, 1, option);
              }}
            >
              {t(`tab.${option}`)}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "day" && today ? (
        <DaySwitcher
          day={date || today}
          today={today}
          onChange={(next) => {
            setDate(next);
            showDayInAddress(next === today ? null : next);
            void load(next, 1, "day");
          }}
        />
      ) : null}
      {summary && tab === "day" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <p className="text-sm text-muted">{summary.mine ? t("myTotal") : t("dayTotal")}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums" data-testid="sales-day-total">
              {money(summary.totalMinor)}
            </p>
            <p className="text-sm text-muted">{t("count", { count: summary.count })}</p>
          </Card>
          <Card>
            <p className="text-sm text-muted">{t("byMethod")}</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {(["cash", "transfer", "pos"] as const).map((method) => (
                <li key={method} className="flex justify-between gap-3">
                  <span>{t(`mode.${method}`)}</span>
                  <span className="tabular-nums">{money(summary.byMethod[method] ?? "0")}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <p className="text-sm text-muted">{t("onCredit")}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{money(summary.creditMinor)}</p>
          </Card>
        </div>
      ) : null}
      {tab === "day" && top.length > 0 ? (
        <Card data-testid="sales-top-items">
          <p className="text-sm font-medium">{t("topItems")}</p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {top.map((item) => (
              <li key={`${item.name}-${item.unit}`} className="flex min-h-11 items-center justify-between gap-3 py-2">
                <span>
                  <span className="block font-medium">{item.name}</span>
                  <span className="block text-xs text-muted">
                    {t("count", { count: item.salesCount })}
                    {item.costKnown ? "" : ` · ${t("topNoCost")}`}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block tabular-nums">{money(item.totalMinor)}</span>
                  <span className="block text-xs text-muted">{unitName(item.unit, 1)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {loaded && items.length === 0 ? (
        <EmptyState
          title={tab === "day" ? t("emptyTitle") : t(`emptyTab.${tab}`)}
          description={tab === "day" ? (canSell ? t("emptyBody") : t("emptyBodyReadOnly")) : t("emptyTabBody")}
        />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((sale) => (
            <li key={sale.id}>
              <Link href={`/app/sales/${sale.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {sale.view === "full" && sale.customerName ? sale.customerName : (sale.number ?? sale.invoiceNumber ?? (sale.view === "full" ? sale.externalRef : null) ?? t("historyRecord"))}
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {[
                      sale.view === "full" && sale.customerName ? (sale.number ?? sale.invoiceNumber) : null,
                      formatWhen(sale.soldAt, locale, timeZone),
                      sale.view === "full" && sale.methods?.length ? sale.methods.map((method) => t(`mode.${method}`)).join(" + ") : null,
                      sale.byName,
                      sale.view === "release" && sale.itemCount ? t("itemCount", { count: sale.itemCount }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {sale.view === "full" ? <span className="text-sm font-medium tabular-nums">{money(sale.totalMinor)}</span> : null}
                  {sale.status === "voided" ? (
                    <Badge tone="danger">{t("voided")}</Badge>
                  ) : sale.status === "awaiting_payment" ? (
                    <Badge tone="warning">{t("stage.awaiting_payment")}</Badge>
                  ) : sale.status === "awaiting_release" ? (
                    <Badge tone="info">{sale.paymentState === "credit" ? t("releaseOnCredit") : t("stage.awaiting_release")}</Badge>
                  ) : sale.historyOnly ? (
                    <Badge>{t("history")}</Badge>
                  ) : sale.view === "full" && BigInt(sale.balanceMinor) > 0n ? (
                    <Badge tone="warning">{t("owingAmount", { amount: money(sale.balanceMinor) })}</Badge>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > SALE_PAGE_SIZE ? (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="font-medium text-primary" disabled={page <= 1} onClick={() => void load(date, page - 1, tab)}>
            {t("previous")}
          </button>
          <span>{t("page", { page, pages })}</span>
          <button type="button" className="font-medium text-primary" disabled={page >= pages} onClick={() => void load(date, page + 1, tab)}>
            {t("next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function SalesPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE, Permission.SALES_READ_OWN, Permission.SALES_READ_ALL, Permission.SALES_COLLECT, Permission.SALES_RELEASE]}>
      <SalesScreen />
    </RequireAccess>
  );
}
