"use client";

import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Permission } from "@bizora/contracts";
import { can, homeCards } from "../../lib/access";
import { useAccess } from "../../lib/access-context";
import { api } from "../../lib/api";
import { ActionLink } from "../../components/action-link";
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
  const seesCash = shown.includes("cash");
  const seesProfit = can(access, Permission.REPORTS_PROFIT_READ) && shown.includes("money");
  const approvesExpenses = can(access, Permission.EXPENSES_APPROVE);
  const [cash, setCash] = useState<{ currency: string; totalMinor: bigint; shops: number } | null>(null);
  const [profit, setProfit] = useState<{ currency: string; profitMinor: string; active: boolean } | null>(null);
  const [expensesToApprove, setExpensesToApprove] = useState(0);

  useEffect(() => {
    if (seesCash) {
      void api("/api/v1/money/cash")
        .then(async (response) => {
          if (!response.ok) return;
          const data = (await response.json()).data as { currency: string; shops: { expectedMinor: string }[] };
          setCash({ currency: data.currency, totalMinor: data.shops.reduce((sum, shop) => sum + BigInt(shop.expectedMinor), 0n), shops: data.shops.length });
        })
        .catch(() => undefined);
    }
    if (seesProfit) {
      void api("/api/v1/money/profit")
        .then(async (response) => {
          if (!response.ok) return;
          const data = (await response.json()).data as { currency: string; profitMinor: string; salesMinor: string; expensesMinor: string };
          setProfit({ currency: data.currency, profitMinor: data.profitMinor, active: data.salesMinor !== "0" || data.expensesMinor !== "0" });
        })
        .catch(() => undefined);
    }
    if (approvesExpenses) {
      void api("/api/v1/money/expenses/waiting")
        .then(async (response) => (response.ok ? setExpensesToApprove((await response.json()).data.count) : undefined))
        .catch(() => undefined);
    }
  }, [seesCash, seesProfit, approvesExpenses]);

  useEffect(() => {
    if (!reconciles) return;
    void api("/api/v1/reconciliation/counts")
      .then(async (response) => (response.ok ? setBank((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [reconciles]);
  const [debtors, setDebtors] = useState<{ currency: string; owingMinor: string; overdueMinor: string; debtors: number } | null>(null);
  const [topDebtors, setTopDebtors] = useState<{ customerId: string; name: string; owingMinor: string; overdueMinor: string }[]>([]);

  useEffect(() => {
    if (!seesDebtors) return;
    // The list (most overdue first) carries the totals too: one call for the figure and the names.
    void api("/api/v1/debtors")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()).data;
        setDebtors({ currency: data.currency, ...data.totals });
        setTopDebtors(data.items.slice(0, 3));
      })
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
    })();
  }, []);

  const figureCards = (
    [
      ["toCollect", t("toCollect"), t("toCollectEmpty")],
      ["toRelease", t("toRelease"), t("toReleaseEmpty")],
      ["sales", t("sales"), t("emptySales")],
      ["mySales", t("mySales"), t("emptySales")],
      ["money", seesProfit ? t("profit") : t("bankTitle"), seesProfit ? t("emptyProfit") : t("emptyMoney")],
      ["cash", t("cash"), t("emptyCash")],
      ["debtors", t("debtors"), t("emptyDebtors")],
      ["stock", t("stock"), t("emptyStock")],
      ["staff", t("staff"), t("emptyStaff")],
      ["approval", t("approval"), t("emptyApproval")],
    ] as const
  )
    // Staff activity is not built yet. Money shows with today's profit, or when there are bank lines to check.
    .filter(([id]) => shown.includes(id) && id !== "staff" && (id !== "money" || seesProfit || (bank?.open ?? 0) > 0));
  const unfinished = checks.filter((check) => !check.done);
  const today = t("today", { date: formatWhen(new Date(), locale, timezone) });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("welcome", { name: name || t("fallbackName") })}
        description={seesCustomers ? `${t("customerCount", { count: customerCount })} · ${today}` : today}
      />
      {sells ? (
        <ActionLink href="/app/sales/new" variant="primary" className="h-14 w-full text-base sm:w-auto sm:px-10" data-testid="home-new-sale">
          {t("newSale")}
        </ActionLink>
      ) : null}
      {unfinished.length > 0 ? (
        <Card data-testid="home-checklist">
          <p className="text-sm font-medium">{t("setup")}</p>
          <p className="text-xs text-muted">{t("setupProgress", { done: checks.length - unfinished.length, total: checks.length })}</p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {checks.map((check) => (
              <li key={check.id}>
                <Link href={check.href} className="flex min-h-11 items-center justify-between gap-3">
                  <span className={check.done ? "text-muted line-through" : "font-medium"}>{t(`checklist.${check.id}`)}</span>
                  <span className={check.done ? "text-success" : "text-primary"}>{check.done ? t("done") : t("start")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
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
              <div className="mt-1">
                <Link href="/app/debtors" className="block" data-testid="home-debtors">
                  <span className="block text-xl font-semibold tabular-nums">{formatCurrency(BigInt(debtors.owingMinor), debtors.currency, locale)}</span>
                  <span className="block text-sm text-muted">{t("debtorsCount", { count: debtors.debtors })}</span>
                  {BigInt(debtors.overdueMinor) > 0n ? (
                    <span className="block text-sm text-danger">{t("debtorsOverdue", { amount: formatCurrency(BigInt(debtors.overdueMinor), debtors.currency, locale) })}</span>
                  ) : null}
                </Link>
                <ul className="mt-2 space-y-1 text-sm">
                  {topDebtors.map((debtor) => (
                    <li key={debtor.customerId}>
                      <Link href={`/app/debtors/${debtor.customerId}`} className="flex min-h-9 items-center justify-between gap-2 text-primary">
                        <span className="truncate">{debtor.name}</span>
                        <span className={`tabular-nums ${BigInt(debtor.overdueMinor) > 0n ? "text-danger" : "text-fg"}`}>{formatCurrency(BigInt(debtor.owingMinor), debtors.currency, locale)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
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
            ) : id === "approval" && (countsToApprove > 0 || expensesToApprove > 0) ? (
              <div className="mt-2 space-y-1 text-sm">
                {countsToApprove > 0 ? (
                  <Link href="/app/stock" className="block text-primary">
                    {t("approvalCounts", { count: countsToApprove })}
                  </Link>
                ) : null}
                {expensesToApprove > 0 ? (
                  <Link href="/app/money/expenses?status=waiting" className="block text-primary" data-testid="home-expenses-to-approve">
                    {t("approvalExpenses", { count: expensesToApprove })}
                  </Link>
                ) : null}
              </div>
            ) : id === "cash" && cash ? (
              <Link href="/app/money/cash" className="mt-1 block" data-testid="home-cash">
                <span className="block text-xl font-semibold tabular-nums">{formatCurrency(cash.totalMinor, cash.currency, locale)}</span>
                <span className="block text-sm text-muted">{t("cashTotal", { count: cash.shops })}</span>
                <span className="text-sm text-primary">{t("seeCash")}</span>
              </Link>
            ) : id === "money" && profit && profit.active ? (
              <Link href="/app/money/profit" className="mt-1 block" data-testid="home-profit">
                <span className={`block text-xl font-semibold tabular-nums ${BigInt(profit.profitMinor) < 0n ? "text-danger" : ""}`}>
                  {formatCurrency(BigInt(profit.profitMinor), profit.currency, locale)}
                </span>
                <span className="text-sm text-primary">{t("seeProfit")}</span>
              </Link>
            ) : (
              <p className="mt-2 text-sm">{empty}</p>
            )}
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
    </div>
  );
}
