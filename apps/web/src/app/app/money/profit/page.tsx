"use client";

import { Permission } from "@bizora/contracts";
import { Card, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { DaySwitcher } from "../../../../components/day-switcher";
import { RequireAccess } from "../../../../components/require-access";
import { formatCurrency, formatDay } from "../../../../i18n/format";
import { api } from "../../../../lib/api";
import type { Profit } from "../../../../lib/money-client";

type View = "day" | "month";

/** Profit for a day or for the month so far, worked out from the books (ADR-028). */
function ProfitScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const [view, setView] = useState<View>("day");
  const [day, setDay] = useState("");
  const [profit, setProfit] = useState<Profit | null>(null);

  const load = useCallback(async (nextView: View, nextDay: string) => {
    const query = nextView === "month" && nextDay ? `?from=${nextDay.slice(0, 8)}01&to=${nextDay}` : nextDay ? `?from=${nextDay}&to=${nextDay}` : "";
    const response = await api(`/api/v1/money/profit${query}`).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()).data as Profit;
    setProfit(data);
    if (!nextDay) setDay(data.to);
  }, []);

  useEffect(() => {
    void load("day", "");
  }, [load]);

  const money = (minor: string | bigint) => (profit ? formatCurrency(BigInt(minor), profit.currency, locale) : "");
  const result = profit ? BigInt(profit.profitMinor) : 0n;
  const nothing = profit && profit.salesMinor === "0" && profit.expensesMinor === "0" && profit.costOfSalesMinor === "0" && profit.otherIncomeMinor === "0";
  const monthName = day ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : "";

  return (
    <div className="space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("profit.title")} intro={t("profit.lead")} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist">
          {(["day", "month"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              className={`min-h-11 rounded-control border px-4 text-sm font-medium ${view === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
              onClick={() => {
                const today = profit?.today ?? day;
                setView(option);
                if (option === "month") setDay(today);
                void load(option, option === "month" ? today : day);
              }}
            >
              {option === "day" ? t("profit.viewDay") : t("profit.viewMonth")}
            </button>
          ))}
        </div>
        {view === "day" && profit ? (
          <DaySwitcher
            day={day}
            today={profit.today}
            onChange={(next) => {
              setDay(next);
              void load("day", next);
            }}
          />
        ) : view === "month" ? (
          <p className="text-sm text-muted">{t("profit.monthLabel", { month: monthName })}</p>
        ) : null}
      </div>
      {profit ? (
        <Card className="space-y-4" data-testid="profit-card">
          <div>
            <p className="text-sm text-muted">{result < 0n ? t("profit.loss") : t("profit.profit")}</p>
            <p className={`text-3xl font-semibold tabular-nums ${result < 0n ? "text-danger" : "text-success"}`} data-testid="profit-amount">
              {money(result < 0n ? -result : result)}
            </p>
            {profit.expensesAwaitingApproval > 0 ? <p className="mt-1 text-xs text-warning">{t("profit.waiting", { count: profit.expensesAwaitingApproval })}</p> : null}
          </div>
          {nothing ? (
            <p className="text-sm text-muted">{t("profit.noActivity")}</p>
          ) : (
            <dl className="space-y-1 text-sm">
              <Line label={t("profit.sales")} value={money(profit.salesMinor)} />
              {profit.discountsMinor !== "0" ? <Line label={t("profit.discounts")} value={`− ${money(profit.discountsMinor)}`} /> : null}
              {profit.returnsMinor !== "0" ? <Line label={t("profit.returns")} value={`− ${money(profit.returnsMinor)}`} /> : null}
              <Line label={t("profit.cost")} value={`− ${money(profit.costOfSalesMinor)}`} />
              <Line label={t("profit.gross")} value={money(profit.grossProfitMinor)} strong />
              {profit.otherIncomeMinor !== "0" ? <Line label={t("profit.otherIncome")} value={`+ ${money(profit.otherIncomeMinor)}`} /> : null}
              <Line label={t("profit.expenses")} value={`− ${money(profit.expensesMinor)}`} />
              <ul className="space-y-1 pl-4 text-muted">
                {profit.expenses.map((expense) => (
                  <li key={expense.name} className="flex justify-between gap-3">
                    <span>{expense.name}</span>
                    <span className="tabular-nums">{money(expense.amountMinor)}</span>
                  </li>
                ))}
              </ul>
            </dl>
          )}
          <p className="text-xs text-muted">{t("profit.costNote")}</p>
        </Card>
      ) : null}
      {view === "month" && profit?.days && profit.days.length > 1 ? (
        <Card>
          <p className="text-sm font-medium">{t("profit.byDay")}</p>
          <ul className="mt-2 divide-y divide-border text-sm" data-testid="profit-days">
            {profit.days.map((row) => {
              const amount = BigInt(row.profitMinor);
              return (
                <li key={row.date} className="flex min-h-10 items-center justify-between gap-3">
                  <span>{formatDay(row.date, locale)}</span>
                  <span className="text-muted tabular-nums">{money(row.netSalesMinor)}</span>
                  <span className={`tabular-nums ${amount < 0n ? "text-danger" : ""}`}>{money(row.profitMinor)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-border pt-1 font-medium" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export default function ProfitPage() {
  return (
    <RequireAccess anyOf={[Permission.REPORTS_PROFIT_READ]}>
      <ProfitScreen />
    </RequireAccess>
  );
}
