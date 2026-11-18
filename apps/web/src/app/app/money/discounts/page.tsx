"use client";

import { Permission } from "@bizora/contracts";
import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BackLink } from "../../../../components/action-link";
import { DaySwitcher } from "../../../../components/day-switcher";
import { RequireAccess } from "../../../../components/require-access";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import type { DiscountsReport } from "../../../../lib/money-client";

type View = "day" | "month";

/** Discounts and cancellations (ADR-031): where money left at the counter, and who did it, for a day or a month. */
function DiscountsScreen() {
  const t = useTranslations("money.discounts");
  const locale = useLocale();
  const place = usePlace();
  const [view, setView] = useState<View>("day");
  const [day, setDay] = useState("");
  const [report, setReport] = useState<DiscountsReport | null>(null);

  const load = useCallback(async (nextView: View, nextDay: string) => {
    const query = nextView === "month" && nextDay ? `?from=${nextDay.slice(0, 8)}01&to=${nextDay}` : nextDay ? `?from=${nextDay}&to=${nextDay}` : "";
    const response = await api(`/api/v1/money/discounts-cancellations${query}`).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()).data as DiscountsReport;
    setReport(data);
    if (!nextDay) setDay(data.to);
  }, []);

  useEffect(() => {
    void load("day", "");
  }, [load]);

  const money = (minor: string) => (report ? formatCurrency(BigInt(minor), report.currency, locale) : "");
  const when = (value: string | null) => (value ? formatWhen(value, locale, place.timezone) : "");
  const monthName = day ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : "";
  const totals = report?.totals;
  const nothing = totals && Object.values(totals).every((value) => value === "0");

  return (
    <div className="space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("title")} intro={t("lead")} />
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
                const today = report?.today ?? day;
                setView(option);
                if (option === "month") setDay(today);
                void load(option, option === "month" ? today : day);
              }}
            >
              {option === "day" ? t("viewDay") : t("viewMonth")}
            </button>
          ))}
        </div>
        {view === "day" && report ? (
          <DaySwitcher
            day={day}
            today={report.today}
            onChange={(next) => {
              setDay(next);
              void load("day", next);
            }}
          />
        ) : view === "month" ? (
          <p className="text-sm text-muted">{t("monthLabel", { month: monthName })}</p>
        ) : null}
      </div>

      {report && totals ? (
        <Card data-testid="discounts-totals">
          {nothing ? (
            <p className="text-sm text-muted">{t("nothing")}</p>
          ) : (
            <dl className="space-y-1 text-sm">
              <Line label={t("totalDiscounts")} value={money(totals.discountsMinor)} />
              <Line label={t("totalCancelled")} value={money(totals.cancelledSalesMinor)} />
              <Line label={t("totalReturns")} value={money(totals.returnsMinor)} />
              <Line label={t("totalPaymentsCancelled")} value={money(totals.paymentsCancelledMinor)} />
              <Line label={t("totalLost")} value={money(totals.transfersNotReceivedMinor)} danger={totals.transfersNotReceivedMinor !== "0"} />
            </dl>
          )}
        </Card>
      ) : null}

      {report && report.people.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">{t("byPerson")}</p>
          <ul className="divide-y divide-border text-sm" data-testid="discounts-people">
            {report.people.map((row) => (
              <li key={row.name} className="space-y-0.5 py-2">
                <p className="font-medium">{row.name || t("someone")}</p>
                <p className="text-muted">
                  {[
                    row.discountCount > 0 ? t("personDiscounts", { count: row.discountCount, amount: money(row.discountsMinor) }) : null,
                    row.cancelledCount > 0 ? t("personCancelled", { count: row.cancelledCount, amount: money(row.cancelledMinor) }) : null,
                    row.returnsCount > 0 ? t("personReturns", { count: row.returnsCount, amount: money(row.returnsMinor) }) : null,
                    row.lostCount > 0 ? t("personLost", { count: row.lostCount, amount: money(row.lostMinor) }) : null,
                  ]
                    .filter(Boolean)
                    .join("; ")}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {report ? (
        <>
          <Section title={t("discountsTitle")} empty={report.discounts.length === 0}>
            {report.discounts.map((row) => (
              <Row
                key={row.saleId}
                href={`/app/sales/${row.saleId}`}
                title={row.number ?? ""}
                amount={money(row.givenMinor)}
                lines={[
                  [
                    row.discountMinor !== "0" ? t("offTotal", { amount: money(row.discountMinor) }) : null,
                    row.loweredMinor !== "0" ? t("lowered", { amount: money(row.loweredMinor) }) : null,
                    t("saleTotal", { amount: money(row.totalMinor) }),
                  ]
                    .filter(Boolean)
                    .join("; "),
                  t("byWhen", { name: row.byName ?? t("someone"), when: when(row.at) }),
                ]}
              />
            ))}
          </Section>
          <Section title={t("cancelledTitle")} empty={report.cancellations.length === 0}>
            {report.cancellations.map((row) => (
              <Row
                key={row.saleId}
                href={`/app/sales/${row.saleId}`}
                title={row.number ?? ""}
                amount={money(row.totalMinor)}
                lines={[
                  row.reason ?? "",
                  t("cancelledBy", { name: row.byName ?? t("someone"), when: when(row.at), seller: row.soldByName ?? t("someone") }),
                  row.paid ? t("wasPaid") : t("wasUnpaid"),
                ]}
              />
            ))}
          </Section>
          <Section title={t("returnsTitle")} empty={report.returns.length === 0}>
            {report.returns.map((row) => (
              <Row
                key={row.id}
                href={`/app/sales/${row.saleId}`}
                title={t("returnOf", { number: row.number, sale: row.saleNumber ?? "" })}
                amount={money(row.totalMinor)}
                lines={[row.reason, t("byWhen", { name: row.byName ?? t("someone"), when: when(row.at) })]}
              />
            ))}
          </Section>
          <Section title={t("paymentsTitle")} empty={report.paymentsCancelled.length === 0}>
            {report.paymentsCancelled.map((row) => (
              <Row
                key={row.id}
                title={t("paymentOf", { number: row.number, customer: row.customerName ?? "" })}
                amount={money(row.amountMinor)}
                lines={[row.reason ?? "", t("byWhen", { name: row.byName ?? t("someone"), when: when(row.at) })]}
              />
            ))}
          </Section>
          <Section title={t("lostTitle")} empty={report.transfersNotReceived.length === 0}>
            {report.transfersNotReceived.map((row) => (
              <Row
                key={row.id}
                {...(row.saleId ? { href: `/app/sales/${row.saleId}` } : {})}
                title={row.number ?? ""}
                amount={money(row.amountMinor)}
                lines={[
                  row.settle === "lost" ? t("lostWrittenOff") : t("lostOwed", { customer: row.customerName ?? "" }),
                  row.reason ?? "",
                  t("takenBy", { name: row.byName ?? t("someone"), when: when(row.at) }),
                ]}
              />
            ))}
          </Section>
        </>
      ) : null}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  if (empty) return null;
  return (
    <Card>
      <p className="mb-2 text-sm font-medium">{title}</p>
      <ul className="divide-y divide-border text-sm" aria-label={title}>
        {children}
      </ul>
    </Card>
  );
}

function Row({ href, title, amount, lines }: { href?: string; title: string; amount: string; lines: string[] }) {
  return (
    <li className="space-y-0.5 py-2">
      <div className="flex justify-between gap-3">
        {href ? (
          <Link href={href} className="font-medium text-primary">
            {title}
          </Link>
        ) : (
          <span className="font-medium">{title}</span>
        )}
        <span className="tabular-nums">{amount}</span>
      </div>
      {lines
        .filter((line) => line)
        .map((line) => (
          <p key={line} className="text-muted">
            {line}
          </p>
        ))}
    </li>
  );
}

function Line({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className={`tabular-nums ${danger ? "font-medium text-danger" : ""}`}>{value}</dd>
    </div>
  );
}

export default function DiscountsPage() {
  return (
    <RequireAccess anyOf={[Permission.REPORTS_PROFIT_READ]}>
      <DiscountsScreen />
    </RequireAccess>
  );
}
