"use client";

import { IDEMPOTENCY_HEADER, parseAmount, Permission, quantityToString, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, FormField, Input, PageHeader, Select } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ActionLink, BackLink } from "../../../../components/action-link";
import { JobLinesEditor, RegularsList } from "../../../../components/job-lines-editor";
import { RequireAccess } from "../../../../components/require-access";
import { SendPdf } from "../../../../components/send-pdf";
import { AmountInput, SentenceInput } from "../../../../components/typing";
import { formatCurrency, formatDay, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { linesToPayload, type DraftLine, type JobView, type Regular } from "../../../../lib/jobs-client";
import { problemOf } from "../../../../lib/money-client";

const today = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
const tone = { open: "warning", done: "success", cancelled: "neutral" } as const;

/** One job (ADR-035): its lines, the money taken, what is left to pay, and finishing it. */
function JobScreen() {
  const t = useTranslations("jobs");
  const units = useTranslations("units");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const params = useParams<{ id: string }>();
  const takesMoney = can(access, Permission.PAYMENTS_RECORD, Permission.SALES_COLLECT);
  const [view, setView] = useState<JobView | null>(null);
  const [regulars, setRegulars] = useState<Regular[]>([]);
  const [adding, setAdding] = useState<DraftLine[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer" | "pos">("cash");
  const [dueDate, setDueDate] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (minor: string | bigint) => formatCurrency(BigInt(minor), place.currency, locale);

  const load = useCallback(async () => {
    const response = await api(`/api/v1/jobs/${params.id}`).catch(() => null);
    if (response?.ok) setView((await response.json()).data as JobView);
  }, [params.id]);

  useEffect(() => {
    void load();
    void api("/api/v1/jobs/regulars")
      .then(async (response) => (response.ok ? setRegulars((await response.json()).data.items as Regular[]) : undefined))
      .catch(() => undefined);
    if (new URLSearchParams(window.location.search).get("saved")) setNotice(t("saved"));
  }, [load, t]);

  async function send(path: string, body: unknown, done: string, key?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await api(path, { method: "POST", body: JSON.stringify(body), ...(key ? { headers: { [IDEMPOTENCY_HEADER]: key } } : {}) }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(response ? await problemOf(response, t("failed")) : t("failed"));
      return false;
    }
    setView((await response.json()).data as JobView);
    setNotice(done);
    return true;
  }

  if (!view) return <p className="text-sm text-muted">{t("loading")}</p>;
  const { job, totals } = view;
  const open = job.status === "open";
  const active = view.lines.filter((line) => !line.removed);
  const removed = view.lines.filter((line) => line.removed);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <BackLink href="/app/jobs">{t("back")}</BackLink>
      <PageHeader
        title={`${job.number}${job.title ? ` · ${job.title}` : ""}`}
        description={view.customer ? `${view.customer.name}${view.customer.phone ? ` · ${view.customer.phone}` : ""}` : undefined}
        actions={<Badge tone={tone[job.status]}>{t(`status.${job.status}`)}</Badge>}
      />
      {notice ? (
        <p className="text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Card className="space-y-2 text-sm">
        <p>
          {t("cameIn", { day: formatDay(job.openedOn, locale) })}
          {job.promisedOn ? ` · ${t("readyBy", { day: formatDay(job.promisedOn, locale) })}` : ""}
        </p>
        {job.problem ? <p>{job.problem}</p> : null}
        {job.summary ? <p className="text-muted">{job.summary}</p> : null}
        {view.customer ? (
          <Link className="text-primary underline" href={`/app/customers/${view.customer.id}`}>
            {t("customerRecord")}
          </Link>
        ) : null}
        {job.status === "cancelled" ? <p className="text-muted">{t("cancelledBecause", { reason: job.cancelReason ?? "" })}</p> : null}
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-medium">{t("linesTitle")}</p>
        {active.length === 0 ? <p className="text-sm text-muted">{t("lines.none")}</p> : null}
        <ul className="divide-y divide-border text-sm" data-testid="job-saved-lines">
          {active.map((line) => (
            <li key={line.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{line.description}</p>
                  <p className="text-muted">
                    {t(`lines.kinds.${line.kind}`)}
                    {line.kind === "part" || line.kind === "bought" ? ` · ${quantityToString(BigInt(line.quantity))} ${units(line.unit, { count: Number(BigInt(line.quantity) / 1000n) })}` : ""}
                    {line.costMinor !== undefined && line.kind !== "work" ? ` · ${t("costLine", { amount: money(line.costMinor) })}` : ""}
                    {line.kind === "helper" || line.kind === "bought" ? ` · ${t(`lines.paidFrom.${line.paidFrom ?? "cash"}`)}` : ""}
                  </p>
                </div>
                <span className="font-medium">{line.kind === "helper" ? t("notCharged") : money(line.totalMinor)}</span>
              </div>
              {open && removing === line.id ? (
                <div className="flex flex-wrap items-end gap-2">
                  <FormField id={`remove-${line.id}`} label={t("removeWhy")}>
                    <SentenceInput id={`remove-${line.id}`} value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} />
                  </FormField>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (await send(`/api/v1/jobs/${job.id}/lines/${line.id}/remove`, { reason }, t("removed", { line: line.description }))) {
                        setRemoving(null);
                        setReason("");
                      }
                    }}
                  >
                    {t("removeConfirm")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                    {t("keep")}
                  </Button>
                </div>
              ) : open ? (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(line.id)}>
                  {t("removeLine")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {removed.length > 0 ? (
          <details className="text-sm text-muted">
            <summary>{t("removedLines", { count: removed.length })}</summary>
            <ul className="mt-2 space-y-1">
              {removed.map((line) => (
                <li key={line.id}>
                  {line.description}: {line.removed?.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {open && adding ? (
          <div className="space-y-3">
            <RegularsList regulars={regulars} />
            <JobLinesEditor lines={adding} onChange={setAdding} regulars={regulars} />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || adding.length === 0}
                onClick={async () => {
                  const built = linesToPayload(adding, place.currency);
                  if ("problem" in built) return setError(t(`problems.${built.problem}`, { line: built.line }));
                  if (await send(`/api/v1/jobs/${job.id}/lines`, { lines: built.lines }, t("linesAdded"), uuidv7())) setAdding(null);
                }}
              >
                {t("saveLines")}
              </Button>
              <Button variant="ghost" onClick={() => setAdding(null)}>
                {t("keep")}
              </Button>
            </div>
          </div>
        ) : open ? (
          <Button variant="secondary" onClick={() => setAdding([])}>
            {t("addLines")}
          </Button>
        ) : null}
      </Card>

      <Card className="space-y-3" data-testid="job-money">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>{t("total")}</dt>
          <dd className="text-right font-medium">{money(totals.chargedMinor)}</dd>
          <dt>{t("paidSoFar")}</dt>
          <dd className="text-right">{money(totals.paidMinor)}</dd>
          <dt className="font-medium">{t("left")}</dt>
          <dd className="text-right font-medium" data-testid="job-left">
            {money(BigInt(totals.leftMinor) > 0n ? totals.leftMinor : "0")}
          </dd>
          {totals.costMinor !== undefined ? (
            <>
              <dt className="text-muted">{t("costs")}</dt>
              <dd className="text-right text-muted">{money(totals.costMinor)}</dd>
              <dt className="text-muted">{t("profit")}</dt>
              <dd className="text-right text-muted">{money(totals.profitMinor ?? "0")}</dd>
            </>
          ) : null}
        </dl>
        {view.payments.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {view.payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className={payment.status === "voided" ? "text-muted line-through" : ""}>
                  {t("depositLine", { number: payment.number, amount: money(payment.amountMinor), method: t(`methods.${payment.method as "cash"}`), when: formatWhen(payment.receivedAt, locale, place.timezone) })}
                  {payment.confirmation === "waiting" ? ` · ${t("waitingTransfer")}` : ""}
                </span>
                {payment.status === "recorded" ? <SendPdf url={`/api/v1/payments/${payment.id}/receipt`} label={t("receipt")} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {view.sale ? (
          <div className="flex flex-wrap gap-2">
            <ActionLink href={`/app/sales/${view.sale.id}`} size="sm">
              {view.sale.invoiceNumber ? t("openBill", { number: view.sale.invoiceNumber }) : t("openReceipt", { number: view.sale.number ?? "" })}
            </ActionLink>
          </div>
        ) : null}
        {takesMoney && job.status !== "cancelled" && (open || BigInt(totals.leftMinor) > 0n) ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField id="job-pay" label={open ? t("deposit") : t("payment")}>
              <AmountInput currency={place.currency} id="job-pay" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </FormField>
            <FormField id="job-pay-method" label={t("method")}>
              <Select id="job-pay-method" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                {(["cash", "transfer", "pos"] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`methods.${option}`)}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="flex items-end">
              <Button
                disabled={busy}
                onClick={async () => {
                  const minor = parseAmount(amount, place.currency);
                  if (minor === null || minor <= 0n) return setError(t("problems.paid"));
                  if (await send(`/api/v1/jobs/${job.id}/payments`, { method, amountMinor: minor.toString() }, t("paymentSaved", { amount: money(minor) }), uuidv7())) setAmount("");
                }}
              >
                {t("takePayment")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {open ? (
        <Card className="space-y-3">
          <p className="text-sm font-medium">{t("finishTitle")}</p>
          <p className="text-sm text-muted">{t("finishLead")}</p>
          {BigInt(totals.leftMinor) > 0n ? (
            <FormField id="job-finish-due" label={t("dueDate")} hint={t("dueHint", { amount: money(totals.leftMinor) })}>
              <Input id="job-finish-due" type="date" value={dueDate} min={today(place.timezone)} onChange={(event) => setDueDate(event.target.value)} />
            </FormField>
          ) : null}
          <Button disabled={busy || active.length === 0} onClick={() => void send(`/api/v1/jobs/${job.id}/finish`, dueDate ? { dueDate } : {}, t("finished"), uuidv7())}>
            {t("finish")}
          </Button>
          {active.length === 0 && view.payments.every((payment) => payment.status !== "recorded") ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <FormField id="job-cancel" label={t("cancelWhy")}>
                <SentenceInput id="job-cancel" value={cancelReason} maxLength={240} onChange={(event) => setCancelReason(event.target.value)} />
              </FormField>
              <Button variant="secondary" disabled={busy} onClick={() => void send(`/api/v1/jobs/${job.id}/cancel`, { reason: cancelReason }, t("cancelled"))}>
                {t("cancel")}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

export default function JobPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE, Permission.SALES_READ_ALL, Permission.SALES_READ_OWN]}>
      <JobScreen />
    </RequireAccess>
  );
}
