"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, FormField, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency } from "../../../../i18n/format";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Period = "week" | "month" | "year";
type Point = { label: string; salesMinor: string; discountsMinor: string; returnsMinor: string; netSalesMinor: string };
type Report = {
  period: Period;
  from: string;
  to: string;
  today: string;
  currency: string;
  previous: { from: string; to: string; netSalesMinor: string };
  salesMinor: string;
  discountsMinor: string;
  returnsMinor: string;
  netSalesMinor: string;
  changeBps: number | null;
  salesCount: number;
  averageSaleMinor: string;
  payments: { method: string; amountMinor: string }[];
  stillOwedMinor: string;
  series: Point[];
  topItems: { name: string; unit: string; salesCount: number; quantity: string; totalMinor: string; costKnown: boolean }[];
  byShop: { id: string; name: string; netSalesMinor: string }[] | null;
  byStaff: { id: string | null; name: string; salesCount: number; totalMinor: string }[] | null;
  ownSalesOnly: boolean;
};

const PERIODS: Period[] = ["week", "month", "year"];

/** Moves a day by one week, month or year. */
function shift(day: string, period: Period, by: number) {
  const date = new Date(`${day}T00:00:00Z`);
  if (period === "week") date.setUTCDate(date.getUTCDate() + 7 * by);
  else if (period === "month") date.setUTCMonth(date.getUTCMonth() + by, 1);
  else date.setUTCFullYear(date.getUTCFullYear() + by, 0, 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Sales for a week, month or year (ADR-058): totals from the books, so they match Money › Profit, compared with the
 * period before; a chart by day or month; how people paid; best sellers; and, for owners, by shop and by person.
 */
function SalesReport() {
  const t = useTranslations("salesReport");
  const locale = useLocale();
  const access = useAccess();
  const unitName = useUnitName();
  const [period, setPeriod] = useState<Period>("month");
  const [day, setDay] = useState("");
  const [shop, setShop] = useState("");
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const allShops = !access.membershipBranchId;

  const load = useCallback(async (nextPeriod: Period, nextDay: string, nextShop: string) => {
    setError(null);
    const query = new URLSearchParams({ period: nextPeriod, ...(nextDay ? { date: nextDay } : {}), ...(nextShop ? { branchId: nextShop } : {}) });
    const response = await api(`/api/v1/sales/report?${query.toString()}`).catch(() => null);
    if (!response?.ok) {
      setError(t("failed"));
      return;
    }
    const data = ((await response.json()) as { data: Report }).data;
    setReport(data);
    if (!nextDay) setDay(data.today);
  }, [t]);

  useEffect(() => {
    void load("month", "", "");
    if (allShops) {
      void api("/api/v1/branches")
        .then(async (response) => (response.ok ? ((await response.json()) as { data: { items?: { id: string; name: string; kind?: string; closedAt?: string | null }[] } }).data.items ?? [] : []))
        .then((items) => setShops(items.filter((item) => item.kind !== "warehouse")))
        .catch(() => undefined);
    }
  }, [load, allShops]);

  const money = (minor: string) => (report ? formatCurrency(BigInt(minor), report.currency, locale) : "");
  const choose = (nextPeriod: Period, nextDay: string, nextShop = shop) => {
    setPeriod(nextPeriod);
    setDay(nextDay);
    void load(nextPeriod, nextDay, nextShop);
  };

  const title = report ? periodTitle(report, locale) : "";
  const atLatest = report ? report.to >= report.today : true;

  async function download() {
    const query = new URLSearchParams({ period, ...(day ? { date: day } : {}), ...(shop ? { branchId: shop } : {}) });
    const response = await api(`/api/v1/sales/report.csv?${query.toString()}`).catch(() => null);
    if (!response?.ok) {
      setError(t("failed"));
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `bizora-sales-${period}-${report?.from ?? day}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <BackLink href="/app/sales">{t("back")}</BackLink>
      <PageHeader title={t("title")} intro={report?.ownSalesOnly ? t("leadOwn") : t("lead")} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-2" role="tablist" aria-label={t("periodLabel")}>
          {PERIODS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={period === option}
              className={`min-h-11 rounded-control border px-4 text-sm font-medium ${period === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
              onClick={() => choose(option, day)}
            >
              {t(`periods.${option}`)}
            </button>
          ))}
        </div>
        {allShops && shops.length > 1 ? (
          <FormField id="report-shop" label={t("shop")}>
            <select
              id="report-shop"
              className="h-11 rounded-control border border-border bg-input px-2 text-sm"
              value={shop}
              onChange={(event) => {
                setShop(event.target.value);
                void load(period, day, event.target.value);
              }}
            >
              <option value="">{t("allShops")}</option>
              {shops.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" aria-label={t("earlier")} onClick={() => choose(period, shift(day, period, -1))}>
          ‹
        </Button>
        <p className="min-w-40 text-center font-semibold" data-testid="report-period">
          {title}
        </p>
        <Button type="button" variant="outline" aria-label={t("later")} disabled={atLatest} onClick={() => choose(period, shift(day, period, 1))}>
          ›
        </Button>
      </div>
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-sm text-muted">{t("netSales")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="report-net">
                {money(report.netSalesMinor)}
              </p>
              <p className="text-xs text-muted">
                {report.changeBps === null
                  ? t("noComparison")
                  : t(report.changeBps >= 0 ? "up" : "down", { percent: Math.abs(Math.round(report.changeBps / 100)), before: money(report.previous.netSalesMinor) })}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-muted">{t("count")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="report-count">
                {report.salesCount}
              </p>
              <p className="text-xs text-muted">{t("average", { amount: money(report.averageSaleMinor) })}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted">{t("stillOwed")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{money(report.stillOwedMinor)}</p>
              <p className="text-xs text-muted">{t("stillOwedHint")}</p>
            </Card>
          </div>
          <Card>
            <dl className="space-y-1 text-sm">
              <Row label={t("sales")} value={money(report.salesMinor)} />
              {report.discountsMinor !== "0" ? <Row label={t("discounts")} value={`− ${money(report.discountsMinor)}`} /> : null}
              {report.returnsMinor !== "0" ? <Row label={t("returns")} value={`− ${money(report.returnsMinor)}`} /> : null}
              <Row label={t("netSales")} value={money(report.netSalesMinor)} strong />
            </dl>
          </Card>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{report.period === "year" ? t("byMonth") : t("byDay")}</p>
              <button type="button" className="min-h-11 text-sm text-primary underline underline-offset-2" onClick={() => setTable((shown) => !shown)}>
                {table ? t("showChart") : t("showTable")}
              </button>
            </div>
            {table ? <SeriesTable report={report} money={money} locale={locale} /> : <Bars report={report} money={money} locale={locale} />}
          </Card>
          {report.payments.length > 0 ? (
            <Card>
              <p className="text-sm font-medium">{t("paidWith")}</p>
              <dl className="mt-2 space-y-1 text-sm">
                {report.payments.map((payment) => (
                  <Row key={payment.method} label={t.has(`methods.${payment.method}`) ? t(`methods.${payment.method}`) : payment.method} value={money(payment.amountMinor)} />
                ))}
              </dl>
            </Card>
          ) : null}
          <Card data-testid="report-top-items">
            <p className="text-sm font-medium">{t("topItems")}</p>
            {report.topItems.length === 0 ? <p className="mt-2 text-sm text-muted">{t("nothingSold")}</p> : null}
            <ul className="mt-2 divide-y divide-border text-sm">
              {report.topItems.map((item) => (
                <li key={`${item.name}-${item.unit}`} className="flex min-h-11 items-center justify-between gap-3 py-2">
                  <span>
                    <span className="block font-medium">{item.name}</span>
                    <span className="block text-xs text-muted">
                      {t("sold", { quantity: trimQuantity(item.quantity), unit: unitName(item.unit, 2), count: item.salesCount })}
                      {item.costKnown ? "" : ` ${t("noCost")}`}
                    </span>
                  </span>
                  <span className="tabular-nums">{money(item.totalMinor)}</span>
                </li>
              ))}
            </ul>
          </Card>
          {report.byShop && report.byShop.length > 1 ? (
            <Card>
              <p className="text-sm font-medium">{t("byShop")}</p>
              <dl className="mt-2 space-y-1 text-sm">
                {report.byShop.map((row) => (
                  <Row key={row.id} label={row.name} value={money(row.netSalesMinor)} />
                ))}
              </dl>
            </Card>
          ) : null}
          {report.byStaff && report.byStaff.length > 0 ? (
            <Card>
              <p className="text-sm font-medium">{t("byStaff")}</p>
              <p className="text-xs text-muted">{t("byStaffHint")}</p>
              <dl className="mt-2 space-y-1 text-sm">
                {report.byStaff.map((row) => (
                  <Row key={row.id ?? row.name} label={t("person", { name: row.name, count: row.salesCount })} value={money(row.totalMinor)} />
                ))}
              </dl>
            </Card>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void download()}>
            {t("download")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-border pt-1 font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

const trimQuantity = (thousandths: string) => {
  const value = BigInt(thousandths);
  const whole = value / 1000n;
  const part = value % 1000n;
  return part === 0n ? whole.toString() : `${whole}.${part.toString().padStart(3, "0").replace(/0+$/, "")}`;
};

function pointName(label: string, locale: string, long = false) {
  if (label.length === 7) return new Intl.DateTimeFormat(locale, { month: long ? "long" : "short", year: long ? "numeric" : undefined, timeZone: "UTC" }).format(new Date(`${label}-01T00:00:00Z`));
  return new Intl.DateTimeFormat(locale, long ? { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" }).format(new Date(`${label}T00:00:00Z`));
}

function periodTitle(report: Report, locale: string) {
  const at = (day: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
  if (report.period === "year") return report.from.slice(0, 4);
  if (report.period === "month") return at(report.from, { month: "long", year: "numeric" });
  return `${at(report.from, { day: "numeric", month: "short" })} – ${at(report.to, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** One bar per day (or month) of net sales. A single series, so no legend; tap, point at or focus a bar for its amount. */
function Bars({ report, money, locale }: { report: Report; money: (minor: string) => string; locale: string }) {
  const t = useTranslations("salesReport");
  const values = report.series.map((point) => BigInt(point.netSalesMinor));
  const top = values.reduce((max, value) => (value > max ? value : max), 0n);
  const [active, setActive] = useState<number | null>(null);
  const every = values.length > 12 ? 5 : 1;
  const shown = active !== null ? report.series[active] : null;
  return (
    <div className="mt-2" role="img" aria-label={t("chartLabel", { from: report.from, to: report.to })}>
      <p className="min-h-5 text-sm tabular-nums" aria-live="polite" data-testid="report-bar-value">
        {shown ? `${pointName(shown.label, locale, true)}: ${money(shown.netSalesMinor)}` : t("hoverHint")}
      </p>
      <div className="mt-2 flex h-40 items-end gap-0.5 border-b border-border">
        {values.map((value, index) => {
          const point = report.series[index]!;
          const percent = top > 0n && value > 0n ? Math.max(2, Number((value * 1000n) / top) / 10) : 0;
          return (
            // The whole column is the hit area, wider and taller than a thin bar.
            <button
              key={point.label}
              type="button"
              className="flex h-full min-w-0 flex-1 items-end focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={`${pointName(point.label, locale, true)}: ${money(point.netSalesMinor)}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            >
              <span
                className={`block w-full rounded-t bg-primary ${active === null || active === index ? "" : "opacity-50"}`}
                style={{ height: `${percent}%` }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex gap-0.5 text-xs text-muted" aria-hidden="true">
        {report.series.map((point, index) => (
          <span key={point.label} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
            {index % every === 0 ? pointName(point.label, locale) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function SeriesTable({ report, money, locale }: { report: Report; money: (minor: string) => string; locale: string }) {
  const t = useTranslations("salesReport");
  return (
    <table className="mt-2 w-full text-sm" data-testid="report-table">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-normal">{report.period === "year" ? t("month") : t("day")}</th>
          <th className="py-1 text-right font-normal">{t("netSales")}</th>
        </tr>
      </thead>
      <tbody>
        {report.series.map((point) => (
          <tr key={point.label} className="border-t border-border">
            <td className="py-1">{pointName(point.label, locale, true)}</td>
            <td className="py-1 text-right tabular-nums">{money(point.netSalesMinor)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SalesReportPage() {
  return (
    <RequireAccess anyOf={[Permission.REPORTS_SALES_READ]}>
      <SalesReport />
    </RequireAccess>
  );
}
