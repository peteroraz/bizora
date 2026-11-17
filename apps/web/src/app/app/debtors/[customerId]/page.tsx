"use client";

import { IDEMPOTENCY_HEADER, Permission, parseMoneyInput, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { SendPdf } from "../../../../components/send-pdf";
import { formatCurrency, formatDay, formatPhone, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { enqueue } from "../../../../lib/offline/outbox";
import { isNetworkFailure } from "../../../../lib/offline/sync";
import { BackLink } from "../../../../components/action-link";

type Account = {
  customer: { id: string; name: string; phoneLast4: string | null; phone?: string | null; credit: { allowed: boolean; limitMinor: string | null } };
  currency: string;
  today: string;
  owingMinor: string;
  overdueMinor: string;
  sales: { id: string; number: string | null; invoiceNumber: string | null; soldAt: string; dueDate: string | null; overdue: boolean; totalMinor: string; paidMinor: string; balanceMinor: string }[];
  payments: { id: string; number: string; method: "cash" | "transfer" | "pos"; amountMinor: string; reference: string | null; receivedAt: string; status: "recorded" | "voided"; voidReason: string | null; byName: string | null }[];
  statementPath: string;
  reminder: { text: string; phone: string | null; hrefPrefix: string };
};

function AccountScreen() {
  const t = useTranslations("debtors");
  const methods = useTranslations("sales");
  const locale = useLocale();
  const access = useAccess();
  const { customerId } = useParams<{ customerId: string }>();
  const [account, setAccount] = useState<Account | null>(null);
  const [missing, setMissing] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer" | "pos">("cash");
  const [reference, setReference] = useState("");
  const [saleId, setSaleId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const load = useCallback(async () => {
    const response = await api(`/api/v1/debtors/${customerId}`).catch(() => null);
    if (!response?.ok) {
      if (response) setMissing(true);
      return;
    }
    setAccount((await response.json()).data.account);
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) return <EmptyState title={t("notFound")} description={t("notFoundBody")} />;
  if (!account) return <p className="text-sm text-muted">{t("loading")}</p>;

  const money = (minor: string | bigint) => formatCurrency(BigInt(minor), account.currency, locale);
  const canPay = can(access, Permission.PAYMENTS_RECORD);
  const canManage = can(access, Permission.DEBTORS_MANAGE);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const reminderHref = `${account.reminder.hrefPrefix}?text=${encodeURIComponent(`${account.reminder.text}${origin}${account.statementPath}`)}`;
  const token = account.statementPath.replace("/s/", "");

  async function pay() {
    setError(null);
    setNotice(null);
    const minor = parseMoneyInput(amount);
    if (minor === null || minor <= 0n) {
      setError(t("badAmount"));
      return;
    }
    const id = uuidv7();
    const body = { id, amountMinor: minor.toString(), method, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(saleId ? { saleId } : {}) };
    setPending(true);
    try {
      const response = await api(`/api/v1/debtors/${customerId}/payments`, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: id }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? t("failed"));
        return;
      }
      setNotice(t("paid", { number: payload.data.payment.number, amount: money(minor) }));
      setAmount("");
      setReference("");
      setSaleId("");
      await load();
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
        // No network: kept on the phone and sent once the network is back (ADR-012).
        await enqueue(access.owner, "payment.record", { customerId, ...body, receivedAt: new Date().toISOString() });
        setNotice(t("paidOffline", { amount: money(minor) }));
        setAmount("");
      } else {
        setError(t("failed"));
      }
    } finally {
      setPending(false);
    }
  }

  async function cancelPayment(id: string) {
    setError(null);
    const response = await api(`/api/v1/payments/${id}/void`, { method: "POST", body: JSON.stringify({ reason: voidReason }) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) {
      setError(payload?.error?.message ?? t("failed"));
      return;
    }
    setVoidingId(null);
    setVoidReason("");
    await load();
  }

  async function newLink() {
    const response = await api(`/api/v1/debtors/${customerId}/statement-link`, { method: "POST" }).catch(() => null);
    if (response?.ok) {
      setAccount((await response.json()).data.account);
      setNotice(t("linkReplaced"));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={account.customer.name}
        description={account.customer.phone ? formatPhone(account.customer.phone) : account.customer.phoneLast4 ? t("phoneEnding", { last4: account.customer.phoneLast4 }) : t("noPhone")}
        actions={
          <div className="flex items-center gap-2">
            {account.customer.phone ? (
              <a href={`tel:${account.customer.phone}`} className="inline-flex min-h-11 items-center rounded-control border border-border px-4 text-sm font-medium">
                {t("call")}
              </a>
            ) : null}
            <BackLink href="/app/debtors">{t("allDebtors")}</BackLink>
          </div>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="text-sm text-muted">{t("owes")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="account-owing">
            {money(account.owingMinor)}
          </p>
          {account.customer.credit.limitMinor ? <p className="text-sm text-muted">{t("limit", { amount: money(account.customer.credit.limitMinor) })}</p> : null}
        </Card>
        <Card>
          <p className="text-sm text-muted">{t("overdue")}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${BigInt(account.overdueMinor) > 0n ? "text-danger" : ""}`}>{money(account.overdueMinor)}</p>
        </Card>
      </div>

      <Card>
        <p className="text-sm font-medium">{t("remindTitle")}</p>
        <p className="mb-3 text-sm text-muted">{t("remindLead")}</p>
        <div className="flex flex-wrap items-start gap-3">
          <a href={reminderHref} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-fg">
            {account.reminder.phone ? t("remindCustomer") : t("remindShare")}
          </a>
          <SendPdf url={`/api/v1/public/statements/${token}/pdf`} label={t("sendStatement")} whatsAppHref={reminderHref} />
          <Link href={account.statementPath} target="_blank" className="self-center text-sm text-primary">
            {t("viewStatement")}
          </Link>
          {canManage ? (
            <button type="button" className="self-center text-sm text-primary" onClick={() => void newLink()}>
              {t("newLink")}
            </button>
          ) : null}
        </div>
      </Card>

      {canPay && BigInt(account.owingMinor) > 0n ? (
        <Card>
          <SafeForm className="space-y-3" pending={pending} onSubmit={() => void pay()}>
            <p className="text-sm font-medium">{t("recordTitle")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="pay-amount" label={t("amount")}>
                <Input id="pay-amount" inputMode="decimal" value={amount} placeholder={money(account.owingMinor)} onChange={(event) => setAmount(event.target.value)} />
              </FormField>
              <FormField id="pay-method" label={t("method")}>
                <Select id="pay-method" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                  {(["cash", "transfer", "pos"] as const).map((option) => (
                    <option key={option} value={option}>
                      {methods(`mode.${option}`)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField id="pay-reference" label={t("reference")} hint={t("optional")}>
                <Input id="pay-reference" value={reference} maxLength={80} onChange={(event) => setReference(event.target.value)} />
              </FormField>
              <FormField id="pay-sale" label={t("applyTo")}>
                <Select id="pay-sale" value={saleId} onChange={(event) => setSaleId(event.target.value)}>
                  <option value="">{t("oldestFirst")}</option>
                  {account.sales.map((sale) => (
                    <option key={sale.id} value={sale.id}>
                      {t("saleOption", { number: sale.invoiceNumber ?? sale.number ?? "", amount: money(sale.balanceMinor) })}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            {error ? (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            <SubmitButton pending={pending} pendingLabel={t("saving")}>
              {t("recordButton")}
            </SubmitButton>
          </SafeForm>
        </Card>
      ) : null}
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error && !canPay ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Card>
        <p className="text-sm font-medium">{t("salesTitle")}</p>
        {account.sales.length === 0 ? <p className="mt-2 text-sm text-muted">{t("nothingOwed")}</p> : null}
        <ul className="mt-2 divide-y divide-border">
          {account.sales.map((sale) => (
            <li key={sale.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <Link href={`/app/sales/${sale.id}`} className="font-medium text-primary">
                  {sale.invoiceNumber ?? sale.number}
                </Link>
                <span className="block text-muted">
                  {formatWhen(sale.soldAt, locale, "Africa/Lagos")}
                  {sale.dueDate ? ` · ${t("due", { date: formatDay(sale.dueDate, locale) })}` : ""}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="tabular-nums">{money(sale.balanceMinor)}</span>
                {sale.overdue ? <Badge tone="danger">{t("overdueBadge")}</Badge> : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <p className="text-sm font-medium">{t("paymentsTitle")}</p>
        {account.payments.length === 0 ? <p className="mt-2 text-sm text-muted">{t("noPayments")}</p> : null}
        <ul className="mt-2 divide-y divide-border">
          {account.payments.map((payment) => (
            <li key={payment.id} className="space-y-2 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-medium">{payment.number}</span>
                  <span className="block text-muted">
                    {[formatWhen(payment.receivedAt, locale, "Africa/Lagos"), methods(`mode.${payment.method}`), payment.reference, payment.byName].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span className={`tabular-nums ${payment.status === "voided" ? "line-through text-muted" : ""}`}>{money(payment.amountMinor)}</span>
                  {payment.status === "voided" ? <Badge tone="danger">{t("cancelled")}</Badge> : null}
                </span>
              </div>
              {payment.status === "recorded" ? (
                <div className="flex flex-wrap items-start gap-3">
                  <SendPdf url={`/api/v1/payments/${payment.id}/receipt`} label={t("sendReceipt")} />
                  {canManage ? (
                    voidingId === payment.id ? (
                      <span className="flex flex-wrap items-end gap-2">
                        <FormField id={`void-${payment.id}`} label={t("cancelReason")}>
                          <Input id={`void-${payment.id}`} value={voidReason} maxLength={200} onChange={(event) => setVoidReason(event.target.value)} />
                        </FormField>
                        <Button type="button" size="sm" variant="secondary" disabled={!voidReason.trim()} onClick={() => void cancelPayment(payment.id)}>
                          {t("cancelConfirm")}
                        </Button>
                      </span>
                    ) : (
                      <button type="button" className="text-sm text-primary" onClick={() => setVoidingId(payment.id)}>
                        {t("cancelPayment")}
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export default function DebtorAccountPage() {
  return (
    <RequireAccess anyOf={[Permission.DEBTORS_READ]}>
      <AccountScreen />
    </RequireAccess>
  );
}
