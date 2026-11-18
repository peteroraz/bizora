"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ActionLink, BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { SentenceInput } from "../../../../components/typing";
import { formatCurrency, formatDay } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf, type ExpenseItem, type ExpenseList } from "../../../../lib/money-client";

type View = "range" | "waiting";

/** Expenses: the last 30 days with totals by category, and the owner's approval queue (ADR-028). */
function ExpensesScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const access = useAccess();
  const records = can(access, Permission.EXPENSES_RECORD);
  const [view, setView] = useState<View>("range");
  const [list, setList] = useState<ExpenseList | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async (next: View) => {
    const response = await api(next === "waiting" ? "/api/v1/money/expenses?status=awaiting_approval" : "/api/v1/money/expenses").catch(() => null);
    if (response?.ok) setList((await response.json()).data as ExpenseList);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const start: View = params.get("status") === "waiting" ? "waiting" : "range";
    const saved = params.get("saved");
    if (saved) setNotice(saved === "waiting" ? t("expense.savedWaiting") : t("expense.saved"));
    setView(start);
    void load(start);
  }, [load, t]);

  function show(next: View) {
    setView(next);
    setNotice(null);
    void load(next);
  }

  async function act(item: ExpenseItem, action: "approve" | "void") {
    setError(null);
    const response = await api(`/api/v1/money/expenses/${item.id}/${action}`, {
      method: "POST",
      ...(action === "void" ? { body: JSON.stringify({ reason }) } : {}),
    }).catch(() => null);
    if (!response?.ok) {
      setError(response ? await problemOf(response, t("failed")) : t("failed"));
      return;
    }
    setNotice(action === "approve" ? t("expense.approved") : t("expense.rejected"));
    setCancelling(null);
    setReason("");
    await load(view);
  }

  const money = (minor: string) => (list ? formatCurrency(BigInt(minor), list.currency, locale) : "");

  return (
    <div className="space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader
        title={t("expense.listTitle")}
        intro={t("expensesLead")}
        actions={
          records ? (
            <ActionLink href="/app/money/expenses/new" variant="primary">
              {t("recordExpense")}
            </ActionLink>
          ) : undefined
        }
      />
      <div className="flex gap-2" role="tablist">
        {(["range", "waiting"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={view === option}
            className={`min-h-11 rounded-control border px-4 text-sm font-medium ${view === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
            onClick={() => show(option)}
          >
            {option === "range" ? t("expense.tabRange") : t("expense.tabWaiting")}
          </button>
        ))}
      </div>
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {list && view === "range" && list.items.length > 0 ? (
        <Card data-testid="expense-totals">
          <p className="text-sm text-muted">{t("expense.total")}</p>
          <p className="text-xl font-semibold tabular-nums">{money(list.totalMinor)}</p>
          <p className="mt-3 text-sm font-medium">{t("expense.byCategory")}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {list.byCategory.map((entry) => (
              <li key={entry.categoryId} className="flex justify-between gap-3">
                <span>{entry.name}</span>
                <span className="tabular-nums">{money(entry.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {list && list.items.length === 0 ? (
        <p className="text-sm text-muted">{view === "waiting" ? t("expense.noneWaiting") : t("expense.none")}</p>
      ) : null}
      <ul className="space-y-3" data-testid="expense-list">
        {list?.items.map((item) => (
          <li key={item.id}>
            <Card className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{item.category}</p>
                  <p className="text-sm text-muted">
                    {formatDay(item.expenseDate, locale)} · {item.shop} · {t(`expense.paidFrom_${item.paidFrom}`)}
                  </p>
                  {item.payee || item.note ? <p className="text-sm">{[item.payee, item.note].filter(Boolean).join(": ")}</p> : null}
                  {item.recordedBy ? <p className="text-xs text-muted">{t("expense.recordedBy", { name: item.recordedBy })}</p> : null}
                  {item.voidReason ? <p className="text-xs text-danger">{t("expense.voidedBecause", { reason: item.voidReason })}</p> : null}
                </div>
                <div className="text-right">
                  <p className={`font-semibold tabular-nums ${item.status === "voided" ? "text-muted line-through" : ""}`}>{money(item.amountMinor)}</p>
                  <p className={`text-xs ${item.status === "awaiting_approval" ? "text-warning" : "text-muted"}`}>{t(`expense.status_${item.status}`)}</p>
                </div>
              </div>
              {cancelling === item.id ? (
                <div className="mt-3 space-y-2">
                  <SentenceInput aria-label={t("reason")} placeholder={t("reasonHint")} value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} />
                  <div className="flex gap-2">
                    <Button type="button" variant="danger" size="sm" disabled={reason.trim().length < 3} onClick={() => void act(item, "void")}>
                      {item.canApprove ? t("expense.reject") : t("expense.cancelExpense")}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setCancelling(null)}>
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              ) : item.canApprove || item.canCancel ? (
                <div className="mt-3 flex gap-2">
                  {item.canApprove ? (
                    <Button type="button" size="sm" onClick={() => void act(item, "approve")}>
                      {t("expense.approve")}
                    </Button>
                  ) : null}
                  {item.canCancel ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setCancelling(item.id)}>
                      {item.canApprove ? t("expense.reject") : t("expense.cancelExpense")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <RequireAccess anyOf={[Permission.EXPENSES_RECORD, Permission.EXPENSES_APPROVE, Permission.MONEY_READ]}>
      <ExpensesScreen />
    </RequireAccess>
  );
}
