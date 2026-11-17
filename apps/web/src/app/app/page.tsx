"use client";

import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Permission } from "@bizora/contracts";
import { can, homeCards } from "../../lib/access";
import { useAccess } from "../../lib/access-context";
import { api } from "../../lib/api";
import { useStockText } from "../../components/stock-quantity";
import { formatCurrency, formatWhen } from "../../i18n/format";
import type { SaleSummary } from "../../lib/sales-client";

type Check = { id: string; done: boolean; href: string };
type Followup = { id: string; customerId: string; customerName: string; reason: string; dueAt: string };

export default function AppHomePage() {
  const t = useTranslations("home");
  const locale = useLocale();
  const access = useAccess();
  const shown = homeCards(access);
  const seesCustomers = can(access, Permission.CUSTOMERS_READ);
  const ownFollowupsOnly = !can(access, Permission.FOLLOWUPS_READ_ALL);
  const [name, setName] = useState("");
  const [checks, setChecks] = useState<Check[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [currency, setCurrency] = useState("NGN");
  const [lowStock, setLowStock] = useState<{ id: string; name: string; baseUnit: string; quantity: string }[]>([]);
  const [countsToApprove, setCountsToApprove] = useState(0);
  const stockText = useStockText();
  const seesStock = shown.includes("stock");
  const approvesStock = can(access, Permission.STOCK_ADJUST);
  const seesSales = shown.includes("sales") || shown.includes("mySales");
  const sells = can(access, Permission.SALES_CREATE);
  const [sales, setSales] = useState<SaleSummary | null>(null);
  const [queues, setQueues] = useState<{ awaitingPayment: number | null; awaitingRelease: number | null } | null>(null);
  const seesQueues = shown.includes("toCollect") || shown.includes("toRelease");
  const seesDebtors = shown.includes("debtors");
  const reconciles = can(access, Permission.BANK_RECONCILE) && shown.includes("money");
  const [bank, setBank] = useState<{ open: number } | null>(null);

  useEffect(() => {
    if (!reconciles) return;
    void api("/api/v1/reconciliation/counts")
      .then(async (response) => (response.ok ? setBank((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [reconciles]);
  const [debtors, setDebtors] = useState<{ currency: string; owingMinor: string; overdueMinor: string; debtors: number } | null>(null);

  useEffect(() => {
    if (!seesDebtors) return;
    void api("/api/v1/debtors/totals")
      .then(async (response) => (response.ok ? setDebtors((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [seesDebtors]);

  useEffect(() => {
    if (!seesQueues) return;
    void api("/api/v1/sales/queues")
      .then(async (response) => (response.ok ? setQueues((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [seesQueues]);

  useEffect(() => {
    if (!seesSales) return;
    void api("/api/v1/sales/summary")
      .then(async (response) => (response.ok ? setSales((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [seesSales]);

  useEffect(() => {
    if (seesStock) {
      void api("/api/v1/stock/low")
        .then(async (response) => (response.ok ? setLowStock((await response.json()).data.items.slice(0, 5)) : undefined))
        .catch(() => undefined);
    }
    if (approvesStock) {
      void api("/api/v1/stock/counts")
        .then(async (response) => (response.ok ? setCountsToApprove((await response.json()).data.items.length) : undefined))
        .catch(() => undefined);
    }
  }, [seesStock, approvesStock]);

  useEffect(() => {
    void (async () => {
      const meResponse = await api("/api/v1/auth/me");
      if (!meResponse.ok) return;
      const me = await meResponse.json();
      if (me.data?.onboardingCompleted === false) {
        window.location.href = "/app/onboarding";
        return;
      }
      setName(me.data?.user?.displayName ?? "");
      const dashboard = await api("/api/v1/dashboard");
      if (!dashboard.ok) return;
      const payload = await dashboard.json();
      setChecks(payload.data?.checklist ?? []);
      setFollowups(payload.data?.followupsDueToday ?? []);
      setOverdue(payload.data?.overdueCount ?? 0);
      setCustomerCount(payload.data?.customerCount ?? 0);
      setTimezone(payload.data?.timezone ?? "Africa/Lagos");
      setCurrency(payload.data?.currency ?? "NGN");
    })();
  }, []);

  const figureCards = (
    [
      ["toCollect", t("toCollect"), t("toCollectEmpty")],
      ["toRelease", t("toRelease"), t("toReleaseEmpty")],
      ["sales", t("sales"), t("emptySales")],
      ["mySales", t("mySales"), t("emptySales")],
      ["money", t("money"), t("emptyMoney")],
      ["cash", t("cash"), t("emptyCash")],
      ["debtors", t("debtors"), t("emptyDebtors")],
      ["stock", t("stock"), t("emptyStock")],
      ["staff", t("staff"), t("emptyStaff")],
      ["approval", t("approval"), t("emptyApproval")],
    ] as const
  ).filter(([id]) => shown.includes(id));
  const today = t("today", { date: formatWhen(new Date(), locale, timezone) });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("welcome", { name: name || t("fallbackName") })}
        description={seesCustomers ? `${t("customerCount", { count: customerCount })} · ${today}` : today}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {figureCards.map(([id, title, empty]) => (
          <Card key={id}>
            <p className="text-sm text-muted">{title}</p>
            {id === "stock" ? (
              lowStock.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {lowStock.map((item) => (
                    <li key={item.id}>
                      <Link href={`/app/stock/${item.id}`} className="text-primary">
                        {t("lowStockItem", { name: item.name, quantity: stockText(item.quantity, item.baseUnit) })}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm">{t("noLowStock")}</p>
              )
            ) : id === "debtors" && debtors && debtors.debtors > 0 ? (
              <Link href="/app/debtors" className="mt-1 block" data-testid="home-debtors">
                <span className="block text-xl font-semibold tabular-nums">{formatCurrency(BigInt(debtors.owingMinor), debtors.currency, locale)}</span>
                <span className="block text-sm text-muted">{t("debtorsCount", { count: debtors.debtors })}</span>
                {BigInt(debtors.overdueMinor) > 0n ? (
                  <span className="block text-sm text-danger">{t("debtorsOverdue", { amount: formatCurrency(BigInt(debtors.overdueMinor), debtors.currency, locale) })}</span>
                ) : null}
              </Link>
            ) : id === "toCollect" || id === "toRelease" ? (
              (() => {
                const count = (id === "toCollect" ? queues?.awaitingPayment : queues?.awaitingRelease) ?? 0;
                return count > 0 ? (
                  <Link href="/app/sales" className="mt-1 block" data-testid={`home-${id}`}>
                    <span className="block text-xl font-semibold">{count}</span>
                    <span className="text-sm text-primary">{t(id === "toCollect" ? "toCollectAction" : "toReleaseAction")}</span>
                  </Link>
                ) : (
                  <p className="mt-2 text-sm">{empty}</p>
                );
              })()
            ) : (id === "sales" || id === "mySales") && sales && sales.count > 0 ? (
              <>
                <p className="mt-1 text-xl font-semibold tabular-nums" data-testid="home-sales-total">
                  {formatCurrency(BigInt(sales.totalMinor), sales.currency, locale)}
                </p>
                <p className="text-sm text-muted">{t("salesCount", { count: sales.count })}</p>
                <Link href="/app/sales" className="mt-2 inline-block text-sm text-primary">
                  {t("seeSales")}
                </Link>
              </>
            ) : (id === "sales" || id === "mySales") && sells ? (
              <>
                <p className="mt-2 text-sm">{t("noSalesToday")}</p>
                <Link href="/app/sales/new" className="mt-2 inline-block text-sm font-medium text-primary">
                  {t("recordSale")}
                </Link>
              </>
            ) : id === "approval" && countsToApprove > 0 ? (
              <Link href="/app/stock" className="mt-2 inline-block text-sm text-primary">
                {t("approvalCounts", { count: countsToApprove })}
              </Link>
            ) : (
              <p className="mt-2 text-sm">{empty}</p>
            )}
            {id === "money" ? <p className="mt-2 text-xs text-muted">{t("moneyHint", { amount: formatCurrency(0n, currency, locale) })}</p> : null}
            {id === "money" && bank && bank.open > 0 ? (
              <Link href="/app/money/bank" className="mt-2 block text-sm font-medium text-primary" data-testid="home-bank">
                {t("bankToCheck", { count: bank.open })}
              </Link>
            ) : null}
          </Card>
        ))}
        {shown.includes("findCustomer") ? (
          <Card>
            <p className="text-sm text-muted">{t("findCustomer")}</p>
            <p className="mt-2 text-sm">{t("findCustomerBody")}</p>
            <Link href="/app/customers" className="mt-3 inline-block text-sm font-medium text-primary">
              {t("findCustomerAction")}
            </Link>
          </Card>
        ) : null}
        {shown.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">{t("nothingYet")}</p>
            <p className="mt-2 text-sm">{t("nothingYetBody")}</p>
          </Card>
        ) : null}
        {shown.includes("followups") ? (
          <Card>
            <p className="text-sm text-muted">{ownFollowupsOnly ? t("myFollowups") : t("followups")}</p>
            {followups.length === 0 ? <p className="mt-2 text-sm">{t("noFollowups")}</p> : null}
            <ul className="mt-3 space-y-2 text-sm">
              {followups.map((item) => (
                <li key={item.id}>
                  <Link href={`/app/customers/${item.customerId}`} className="font-medium text-primary">
                    {item.customerName}
                  </Link>
                  <span className="mt-0.5 block text-muted">
                    {item.reason} · {formatWhen(item.dueAt, locale, timezone)}
                  </span>
                </li>
              ))}
            </ul>
            {overdue > 0 ? <p className="mt-3 text-sm text-warning">{t("overdue", { count: overdue })}</p> : null}
            <Link href="/app/customers/follow-ups" className="mt-3 inline-block text-sm font-medium text-primary">
              {t("seeFollowups")}
            </Link>
          </Card>
        ) : null}
      </div>
      {checks.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("setup")}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {checks.map((check) => (
              <li key={check.id}>
                <Link href={check.href} className="flex items-center justify-between gap-3">
                  <span>{t(`checklist.${check.id}`)}</span>
                  <span className={check.done ? "text-success" : "text-muted"}>{check.done ? t("done") : t("todo")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
