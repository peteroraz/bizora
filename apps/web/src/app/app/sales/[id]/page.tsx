"use client";

import { IDEMPOTENCY_HEADER, Permission, quantityToString, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, FormField, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { SaleCollect } from "../../../../components/sale-collect";
import { SaleComments } from "../../../../components/sale-comments";
import { SaleDocuments } from "../../../../components/sale-documents";
import { useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency, formatDay, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { type SaleDetail, type SaleReleaseDetail, whatsAppLink } from "../../../../lib/sales-client";
import { ActionLink, BackLink } from "../../../../components/action-link";
import { SentenceInput } from "../../../../components/typing";

type Loaded = (SaleDetail & { view: "full" }) | (SaleReleaseDetail & { view: "release" });

const STAGE_TONE = { awaiting_payment: "warning", awaiting_release: "info", completed: "success", voided: "danger" } as const;

function SaleScreen() {
  const t = useTranslations("sales");
  const locale = useLocale();
  const access = useAccess();
  const unitName = useUnitName();
  const { id } = useParams<{ id: string }>();
  const [sale, setSale] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [releaseComment, setReleaseComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const response = await api(`/api/v1/sales/${id}`).catch(() => null);
    if (!response?.ok) {
      setMissing(true);
      return;
    }
    setSale((await response.json()).data.sale);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: "void" | "release", body: object) {
    setError(null);
    setPending(true);
    const response = await api(`/api/v1/sales/${id}/${path}`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify(body),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) {
      setVoiding(false);
      setReleaseComment("");
      setSale(payload.data.sale);
      return;
    }
    setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
  }

  if (missing) return <EmptyState title={t("notFound")} description={t("notFoundBody")} />;
  if (!sale) return <p className="text-sm text-muted">{t("loading")}</p>;

  const full = sale.view === "full" ? sale : null;
  const money = (minor: string) => formatCurrency(BigInt(minor), full?.currency ?? "NGN", locale);
  const when = (value: string) => formatWhen(value, locale, "Africa/Lagos");
  const ownUnpaid = sale.status === "awaiting_payment" && sale.mine;
  const canVoid = sale.status !== "voided" && !sale.historyOnly && (can(access, Permission.SALES_VOID) || (ownUnpaid && can(access, Permission.SALES_CREATE)));
  const canCollect = full !== null && sale.status === "awaiting_payment" && can(access, Permission.SALES_COLLECT);
  const canRelease = sale.status === "awaiting_release" && can(access, Permission.SALES_RELEASE);
  const plural = (quantity: string) => (Number(quantityToString(BigInt(quantity))) === 1 ? 1 : 2);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={sale.number ?? sale.invoiceNumber ?? full?.externalRef ?? t("historyRecord")}
        description={[when(sale.soldAt), sale.byName, sale.branchName].filter(Boolean).join(" · ")}
        actions={
          <>
            <BackLink href="/app/sales">{t("allSales")}</BackLink>
            {can(access, Permission.SALES_CREATE) ? (
              <ActionLink href="/app/sales/new" variant="primary" className="h-12 px-6 text-base" data-testid="next-sale">
                {t("nextSale")}
              </ActionLink>
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Badge tone={STAGE_TONE[sale.status]}>{t(`stage.${sale.status}`)}</Badge>
        {sale.status !== "voided" && sale.paymentState !== "unpaid" ? <Badge tone={sale.paymentState === "credit" ? "warning" : "success"}>{t(`payment.${sale.paymentState}`)}</Badge> : null}
        {sale.historyOnly ? <Badge>{t("history")}</Badge> : null}
        {sale.provisionalNumber ? <Badge tone="info">{t("offlineNumber", { number: sale.provisionalNumber })}</Badge> : null}
        {full?.source === "import" ? <Badge>{t("imported")}</Badge> : null}
      </div>
      {sale.invoiceNumber && sale.number ? <p className="text-sm text-muted">{t("invoiceNumberLine", { number: sale.invoiceNumber })}</p> : null}
      {sale.status === "awaiting_payment" && !canCollect ? <p className="text-sm">{t("sendCustomerToCashier", { number: sale.invoiceNumber ?? sale.number ?? "" })}</p> : null}
      {sale.status === "awaiting_release" && !canRelease ? <p className="text-sm">{t("waitingForStore")}</p> : null}
      {sale.historyOnly ? <p className="text-sm text-muted">{t("historyExplain")}</p> : null}
      {full?.voidReason ? <p className="text-sm text-danger">{t("voidedBecause", { reason: full.voidReason })}</p> : null}

      {!sale.historyOnly && access.salesFlow === "desk" ? (
        <ol className="space-y-1 text-sm" aria-label={t("timeline")}>
          <li>{t("stepRecorded", { name: sale.byName ?? t("someone"), when: when(sale.soldAt) })}</li>
          {sale.collectedAt ? (
            <li>{t(sale.paymentState === "credit" ? "stepCredit" : "stepPaid", { name: sale.collectedByName ?? t("someone"), when: when(sale.collectedAt) })}</li>
          ) : null}
          {sale.releasedAt ? <li>{t("stepReleased", { name: sale.releasedByName ?? t("someone"), when: when(sale.releasedAt) })}</li> : null}
        </ol>
      ) : null}

      <Card>
        <ul className="divide-y divide-border">
          {full
            ? full.lines.map((line, index) => (
                <li key={index} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="block font-medium">{line.description}</span>
                    <span className="text-muted">
                      {t("lineDetail", { quantity: quantityToString(BigInt(line.enteredQuantity)), unit: unitName(line.enteredUnit, plural(line.enteredQuantity)), price: money(line.unitPriceMinor) })}
                    </span>
                    {line.costMinor !== undefined ? <span className="block text-xs text-muted">{t("lineCost", { cost: money(line.costMinor) })}</span> : null}
                  </span>
                  <span className="tabular-nums">{money(line.lineTotalMinor)}</span>
                </li>
              ))
            : sale.lines.map((line, index) => (
                <li key={index} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="font-medium">{line.description}</span>
                  <span className="text-base font-semibold">
                    {quantityToString(BigInt(line.enteredQuantity))} {unitName(line.enteredUnit, plural(line.enteredQuantity))}
                  </span>
                </li>
              ))}
        </ul>
        {full ? (
          <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-border pt-3 text-sm">
            {BigInt(full.discountMinor) > 0n ? (
              <>
                <dt className="text-muted">{t("discount")}</dt>
                <dd className="text-right tabular-nums">{money((-BigInt(full.discountMinor)).toString())}</dd>
              </>
            ) : null}
            <dt className="font-medium">{t("total")}</dt>
            <dd className="text-right font-medium tabular-nums">{money(full.totalMinor)}</dd>
            {full.payments.map((payment, index) => (
              <Fragment key={index}>
                <dt className="text-muted">{t(`mode.${payment.method}`)}</dt>
                <dd className="text-right tabular-nums">{money(payment.amountMinor)}</dd>
              </Fragment>
            ))}
            {full.laterPayments.map((payment) => (
              <Fragment key={payment.id}>
                <dt className="text-muted">{t("paidLater", { number: payment.number })}</dt>
                <dd className="text-right tabular-nums">{money(payment.amountMinor)}</dd>
              </Fragment>
            ))}
            {sale.status !== "awaiting_payment" && BigInt(full.balanceMinor) > 0n ? (
              <>
                <dt className="text-warning">{t("owing")}</dt>
                <dd className="text-right tabular-nums text-warning">{money(full.balanceMinor)}</dd>
              </>
            ) : null}
            {full.dueDate ? (
              <>
                <dt className="text-muted">{t("dueDate")}</dt>
                <dd className="text-right">{formatDay(full.dueDate, locale)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </Card>
      {full?.customerName ? (
        <p className="text-sm">
          {full.customerPhoneLast4 ? t("customerWithPhone", { name: full.customerName, last4: full.customerPhoneLast4 }) : t("customerName", { name: full.customerName })}
        </p>
      ) : null}
      {full?.note ? <p className="text-sm text-muted">{full.note}</p> : null}

      {canCollect && full ? <SaleCollect sale={full} onDone={(next) => setSale(next)} /> : null}

      {canRelease ? (
        <Card>
          <SafeForm className="space-y-3" pending={pending} onSubmit={() => void act("release", releaseComment.trim() ? { comment: releaseComment.trim() } : {})}>
            <p className="text-sm font-medium">{t("releaseTitle")}</p>
            <p className="text-sm text-muted">{t(sale.paymentState === "credit" ? "releaseCredit" : "releasePaid")}</p>
            <FormField id="release-comment" label={t("storeComment")} hint={t("optional")}>
              <SentenceInput id="release-comment" value={releaseComment} maxLength={500} onChange={(event) => setReleaseComment(event.target.value)} />
            </FormField>
            <SubmitButton pending={pending} pendingLabel={t("saving")}>
              {t("releaseConfirm")}
            </SubmitButton>
          </SafeForm>
        </Card>
      ) : null}

      {full && full.documents.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("docTitle")}</p>
          <p className="mb-3 text-sm text-muted">{t("docLead")}</p>
          <SaleDocuments
            saleId={full.id}
            documents={full.documents}
            credit={full.paymentState === "credit"}
            receiptPath={full.receiptPath}
            whatsAppPrefix={full.whatsApp.hrefPrefix}
            whatsAppText={full.whatsApp.text}
          />
          <details className="mt-3 text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium text-primary">{t("moreWaysToShare")}</summary>
            <div className="flex flex-wrap gap-4 pt-1">
              <a href={whatsAppLink(full, typeof window === "undefined" ? "" : window.location.origin)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-primary">
                {full.documents.includes("receipt")
                  ? full.whatsApp.phone
                    ? t("sendWhatsAppCustomer")
                    : t("sendWhatsApp")
                  : full.whatsApp.phone
                    ? t("sendInvoiceLinkCustomer")
                    : t("sendInvoiceLink")}
              </a>
              <button
                type="button"
                className="inline-flex min-h-11 items-center text-primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${window.location.origin}${full.receiptPath}`).then(() => setCopied(true));
                }}
              >
                {copied ? t("copied") : t("copyLinkPlain")}
              </button>
              <Link href={full.receiptPath} className="inline-flex min-h-11 items-center text-primary" target="_blank">
                {t("viewAsCustomer")}
              </Link>
            </div>
          </details>
        </Card>
      ) : null}

      {!sale.historyOnly ? <SaleComments saleId={sale.id} comments={sale.comments} onAdded={() => void load()} /> : null}

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {canVoid ? (
        voiding ? (
          <Card>
            <SafeForm className="space-y-3" pending={pending} onSubmit={() => void act("void", { reason })}>
              <p className="text-sm">{sale.status === "awaiting_payment" ? t("voidExplainUnpaid") : t("voidExplain")}</p>
              <FormField id="void-reason" label={t("voidReason")}>
                <SentenceInput id="void-reason" value={reason} required maxLength={200} onChange={(event) => setReason(event.target.value)} />
              </FormField>
              <div className="flex gap-3">
                <SubmitButton pending={pending} pendingLabel={t("saving")}>
                  {t("voidConfirm")}
                </SubmitButton>
                <Button type="button" variant="ghost" onClick={() => setVoiding(false)}>
                  {t("keep")}
                </Button>
              </div>
            </SafeForm>
          </Card>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setVoiding(true)}>
            {t("void")}
          </Button>
        )
      ) : null}
    </div>
  );
}

export default function SalePage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE, Permission.SALES_READ_OWN, Permission.SALES_READ_ALL, Permission.SALES_COLLECT, Permission.SALES_RELEASE]}>
      <SaleScreen />
    </RequireAccess>
  );
}
