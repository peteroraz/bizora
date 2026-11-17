"use client";

import { IDEMPOTENCY_HEADER, Permission, parseMoneyInput, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { dayKey, formatCurrency } from "../i18n/format";
import { DueDatePicker } from "./day-switcher";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
import type { SaleDetail } from "../lib/sales-client";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

type Mode = "cash" | "transfer" | "pos" | "split" | "credit";
type Credit = { allowed: boolean; limitMinor: string | null; owingMinor: string };

/**
 * The cashier's part of the desk flow (ADR-016): take the money, or give credit to a customer a manager approved,
 * with the date they will pay and a comment. The server checks everything again.
 */
export function SaleCollect({ sale, onDone }: { sale: SaleDetail; onDone: (sale: SaleDetail) => void }) {
  const t = useTranslations("sales");
  const locale = useLocale();
  const access = useAccess();
  const canCredit = can(access, Permission.SALES_CREDIT, Permission.DEBTORS_MANAGE);
  const total = BigInt(sale.totalMinor);
  const first: Mode = sale.requestedPayment && (sale.requestedPayment !== "credit" || canCredit) ? sale.requestedPayment : "cash";
  const [mode, setMode] = useState<Mode>(first);
  const [amounts, setAmounts] = useState({ cash: "", transfer: "", pos: "" });
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    sale.customerId && sale.customerName ? { id: sale.customerId, name: sale.customerName, credit: sale.customerCredit ?? undefined } : null,
  );
  const [credit, setCredit] = useState<Credit | null>(sale.customerCredit);
  const [dueDate, setDueDate] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [given, setGiven] = useState("");
  const givenMinor = given.trim() ? parseMoneyInput(given) : null;
  const change = givenMinor !== null ? givenMinor - total : null;
  const money = (minor: bigint) => formatCurrency(minor, sale.currency, locale);

  const parts =
    mode === "split" || mode === "credit"
      ? (["cash", "transfer", "pos"] as const).map((method) => ({ method, amountMinor: amounts[method].trim() ? parseMoneyInput(amounts[method]) : 0n })).filter((part) => part.amountMinor !== 0n)
      : [{ method: mode, amountMinor: total }];
  const paid = parts.reduce((sum, part) => sum + (part.amountMinor ?? 0n), 0n);
  const balance = total - paid;
  const limit = credit?.limitMinor ? BigInt(credit.limitMinor) : null;
  const owing = credit ? BigInt(credit.owingMinor) : 0n;

  async function pick(next: PickedCustomer | null) {
    setCustomer(next);
    setCredit(null);
    if (!next) return;
    const response = await api(`/api/v1/customers/${next.id}`).catch(() => null);
    if (response?.ok) {
      const found = (await response.json()).data.customer;
      setCredit({ allowed: found.credit.allowed, limitMinor: found.credit.limitMinor, owingMinor: found.owingMinor });
    }
  }

  function problem() {
    if (parts.some((part) => part.amountMinor === null)) return t("badAmount");
    if (balance < 0n) return t("overpaid");
    if (balance > 0n) {
      if (!canCredit) return t("creditNotAllowed");
      if (!customer) return t("creditNeedsCustomer");
      if (credit && !credit.allowed) return t("creditCustomerNotApproved", { name: customer.name });
      if (limit !== null && owing + balance > limit && !can(access, Permission.DEBTORS_MANAGE)) return t("overLimit");
      if (!dueDate) return t("creditNeedsDate");
      if (!comment.trim()) return t("creditNeedsComment");
    }
    return null;
  }

  async function submit() {
    setError(null);
    const blocked = problem();
    if (blocked) {
      setError(blocked);
      return;
    }
    setPending(true);
    const response = await api(`/api/v1/sales/${sale.id}/collect`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify({
        payments: parts.map((part) => ({ method: part.method, amountMinor: (part.amountMinor ?? 0n).toString() })),
        ...(customer ? { customerId: customer.id } : {}),
        ...(balance > 0n ? { dueDate } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) {
      onDone(payload.data.sale);
      return;
    }
    setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
  }

  const modes: Mode[] = ["cash", "transfer", "pos", "split", ...(canCredit ? (["credit"] as const) : [])];

  return (
    <Card>
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void submit()}>
        <p className="text-sm font-medium">{t("collectTitle", { total: money(total) })}</p>
        {sale.requestedPayment ? <p className="text-sm text-muted">{t("customerSaid", { method: t(`mode.${sale.requestedPayment}`) })}</p> : null}
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("paidWith")}>
          {modes.map((option) => (
            <Button key={option} type="button" size="sm" variant={mode === option ? "primary" : "secondary"} aria-pressed={mode === option} onClick={() => setMode(option)}>
              {t(`mode.${option}`)}
            </Button>
          ))}
        </div>
        {mode === "cash" ? (
          <div className="flex flex-wrap items-end gap-3">
            <FormField id="collect-given" label={t("cashGiven")} hint={t("optional")}>
              <Input id="collect-given" inputMode="decimal" className="max-w-40" value={given} onChange={(event) => setGiven(event.target.value)} />
            </FormField>
            {change !== null ? (
              <p className={`pb-6 text-base font-semibold tabular-nums ${change < 0n ? "text-danger" : "text-success"}`} role="status">
                {change < 0n ? t("shortBy", { amount: money(-change) }) : t("change", { amount: money(change) })}
              </p>
            ) : null}
          </div>
        ) : null}
        {mode === "split" || mode === "credit" ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {(["cash", "transfer", "pos"] as const).map((method) => (
              <FormField key={method} id={`collect-${method}`} label={mode === "credit" ? t("paidNow", { method: t(`mode.${method}`) }) : t(`mode.${method}`)}>
                <Input id={`collect-${method}`} inputMode="decimal" value={amounts[method]} onChange={(event) => setAmounts({ ...amounts, [method]: event.target.value })} />
              </FormField>
            ))}
          </div>
        ) : null}
        <div>
          <p className="text-sm font-medium">{t("customer")}</p>
          <div className="mt-2">
            <CustomerPicker id="collect-customer" value={customer} onChange={(next) => void pick(next)} />
          </div>
          {customer && credit?.allowed ? (
            <p className="mt-1 text-xs text-muted">
              {limit !== null ? t("creditLimitLine", { limit: money(limit), owing: money(owing) }) : t("creditNoLimitLine", { owing: money(owing) })}
            </p>
          ) : null}
        </div>
        {balance > 0n ? (
          <div className="space-y-3">
            <p className="text-sm text-warning">{t("owingOnCredit", { amount: money(balance) })}</p>
            <FormField id="collect-due" label={t("dueDate")}>
              <DueDatePicker id="collect-due" value={dueDate} today={dayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)} onChange={setDueDate} />
            </FormField>
            <FormField id="collect-comment" label={t("creditComment")}>
              <Input id="collect-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
            </FormField>
          </div>
        ) : (
          <FormField id="collect-comment" label={t("cashierComment")} hint={t("optional")}>
            <Input id="collect-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
          </FormField>
        )}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <SubmitButton pending={pending} pendingLabel={t("saving")}>
          {balance > 0n ? t("giveCredit") : t("takePayment")}
        </SubmitButton>
      </SafeForm>
    </Card>
  );
}
