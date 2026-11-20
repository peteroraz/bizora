"use client";

import { Permission } from "@bizora/contracts";
import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ActionLink } from "../../../components/action-link";
import { RequireAccess } from "../../../components/require-access";
import { formatCurrency } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess, usePlace } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import type { CashPosition, Profit, TransferList } from "../../../lib/money-client";

/** Money (ADR-020, ADR-028): cash in each shop, profit, expenses, money in and out, and bank statements. */
function MoneyScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const reconciles = can(access, Permission.BANK_RECONCILE);
  const seesCash = can(access, Permission.CASH_EXPECTED_READ);
  const counts = can(access, Permission.CASH_CLOSE);
  const collects = can(access, Permission.SALES_COLLECT);
  const seesProfit = can(access, Permission.REPORTS_PROFIT_READ);
  const records = can(access, Permission.EXPENSES_RECORD);
  const approves = can(access, Permission.EXPENSES_APPROVE);
  const [bank, setBank] = useState<{ currency: string; open: number; openMinor: string } | null>(null);
  const [cash, setCash] = useState<CashPosition | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [waiting, setWaiting] = useState(0);
  const seesSuppliers = can(access, Permission.PURCHASES_MANAGE, Permission.MONEY_READ);
  const [suppliers, setSuppliers] = useState<{ currency: string; owedMinor: string; overdueMinor: string } | null>(null);
  const [transfers, setTransfers] = useState<TransferList | null>(null);

  useEffect(() => {
    const load = <T,>(path: string, set: (data: T) => void) =>
      void api(path)
        .then(async (response) => (response.ok ? set((await response.json()).data as T) : undefined))
        .catch(() => undefined);
    if (reconciles) load("/api/v1/reconciliation/counts", setBank);
    if (reconciles) load("/api/v1/transfers", setTransfers);
    if (seesCash) load("/api/v1/money/cash", setCash);
    if (seesProfit) load("/api/v1/money/profit", setProfit);
    if (approves) load<{ count: number }>("/api/v1/money/expenses/waiting", (data) => setWaiting(data.count));
    if (seesSuppliers) load("/api/v1/suppliers/owed", setSuppliers);
  }, [reconciles, seesCash, seesProfit, approves, seesSuppliers]);

  const money = (minor: string, currency: string) => formatCurrency(BigInt(minor), currency, locale);
  const cashTotal = cash ? cash.shops.reduce((sum, shop) => sum + BigInt(shop.expectedMinor), 0n) : null;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} />
      <div className="grid gap-4 sm:grid-cols-2">
        {reconciles ? (
          <Card data-testid="money-transfers">
            <p className="text-sm font-medium">{t("transfersTitle")}</p>
            {transfers && transfers.waitingCount > 0 ? (
              <p className="mt-1 text-xl font-semibold tabular-nums text-warning">
                {t("transfersWaiting", { count: transfers.waitingCount, amount: money(transfers.waitingMinor, place.currency) })}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted">{transfers ? t("transfersNone") : t("transfersLead")}</p>
            )}
            <ActionLink href="/app/money/transfers" size="sm" className="mt-3">
              {t("seeTransfers")}
            </ActionLink>
          </Card>
        ) : null}
        {seesCash || counts ? (
          <Card data-testid="money-cash">
            <p className="text-sm font-medium">{t("cashTitle")}</p>
            {cash && cashTotal !== null ? (
              <p className="mt-1 text-xl font-semibold tabular-nums">{t("cashTotal", { amount: money(cashTotal.toString(), cash.currency), count: cash.shops.length })}</p>
            ) : (
              <p className="mt-1 text-sm text-muted">{seesCash ? t("cashLead") : t("countLead")}</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {counts ? (
                <ActionLink href="/app/money/cash/count" variant="primary" size="sm">
                  {t("countTitle")}
                </ActionLink>
              ) : null}
              {seesCash ? (
                <ActionLink href="/app/money/cash" size="sm">
                  {t("seeCash")}
                </ActionLink>
              ) : null}
              {collects ? (
                <ActionLink href="/app/money/pos-cashout" size="sm" data-testid="money-pos-cashout">
                  {t("posCashout.action")}
                </ActionLink>
              ) : null}
            </div>
          </Card>
        ) : null}
        {seesProfit ? (
          <Card data-testid="money-profit">
            <p className="text-sm font-medium">{t("profitTitle")}</p>
            {profit ? (
              <p className={`mt-1 text-xl font-semibold tabular-nums ${BigInt(profit.profitMinor) < 0n ? "text-danger" : ""}`}>{money(profit.profitMinor, profit.currency)}</p>
            ) : (
              <p className="mt-1 text-sm text-muted">{t("profitLead")}</p>
            )}
            <ActionLink href="/app/money/profit" size="sm" className="mt-3">
              {t("seeProfit")}
            </ActionLink>
          </Card>
        ) : null}
        {seesProfit ? (
          <Card data-testid="money-discounts">
            <p className="text-sm font-medium">{t("discountsTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("discountsLead")}</p>
            <ActionLink href="/app/money/discounts" size="sm" className="mt-3">
              {t("seeDiscounts")}
            </ActionLink>
          </Card>
        ) : null}
        {records || approves ? (
          <Card data-testid="money-expenses">
            <p className="text-sm font-medium">{t("expensesTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("expensesLead")}</p>
            {waiting > 0 ? (
              <Link href="/app/money/expenses?status=waiting" className="mt-2 block text-sm font-medium text-primary" data-testid="money-waiting">
                {t("waiting", { count: waiting })}
              </Link>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {records ? (
                <ActionLink href="/app/money/expenses/new" variant="primary" size="sm">
                  {t("recordExpense")}
                </ActionLink>
              ) : null}
              <ActionLink href="/app/money/expenses" size="sm">
                {t("seeExpenses")}
              </ActionLink>
            </div>
          </Card>
        ) : null}
        {seesSuppliers ? (
          <Card data-testid="money-suppliers">
            <p className="text-sm font-medium">{t("suppliersTitle")}</p>
            {suppliers ? (
              <>
                <p className="mt-1 text-xl font-semibold tabular-nums">{t("suppliersOwed", { amount: money(suppliers.owedMinor, suppliers.currency) })}</p>
                {suppliers.overdueMinor !== "0" ? (
                  <p className="text-sm font-medium text-danger">{t("suppliersLate", { amount: money(suppliers.overdueMinor, suppliers.currency) })}</p>
                ) : null}
              </>
            ) : null}
            <ActionLink href="/app/suppliers" size="sm" className="mt-3">
              {t("seeSuppliers")}
            </ActionLink>
          </Card>
        ) : null}
        {records ? (
          <Card>
            <p className="text-sm font-medium">{t("moveTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("moveLead")}</p>
            <ActionLink href="/app/money/move" size="sm" className="mt-3">
              {t("recordMove")}
            </ActionLink>
          </Card>
        ) : null}
        {reconciles ? (
          <Card>
            <p className="text-sm font-medium">{t("bankTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("bankLead")}</p>
            {bank && bank.open > 0 ? <p className="mt-2 text-sm">{t("toCheck", { count: bank.open, amount: money(bank.openMinor, bank.currency) })}</p> : null}
            <div className="mt-3 flex flex-wrap gap-4 text-sm font-medium">
              <Link href="/app/money/bank" className="text-primary">
                {t("openInbox")}
              </Link>
              <Link href="/app/money/bank/upload" className="text-primary">
                {t("upload")}
              </Link>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

export default function MoneyPage() {
  return (
    <RequireAccess anyOf={[Permission.MONEY_READ, Permission.BANK_RECONCILE, Permission.CASH_CLOSE, Permission.EXPENSES_RECORD]}>
      <MoneyScreen />
    </RequireAccess>
  );
}
