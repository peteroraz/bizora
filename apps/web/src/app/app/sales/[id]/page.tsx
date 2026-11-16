"use client";

import { IDEMPOTENCY_HEADER, Permission, quantityToString, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { type SaleDetail, whatsAppLink } from "../../../../lib/sales-client";

function SaleScreen() {
  const t = useTranslations("sales");
  const locale = useLocale();
  const access = useAccess();
  const unitName = useUnitName();
  const { id } = useParams<{ id: string }>();
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
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

  async function cancelSale() {
    setError(null);
    setPending(true);
    const response = await api(`/api/v1/sales/${id}/void`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify({ reason }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) {
      setVoiding(false);
      setSale(payload.data.sale);
      void load();
      return;
    }
    setError(payload?.error?.message ?? t("failed"));
  }

  if (missing) return <EmptyState title={t("notFound")} description={t("notFoundBody")} />;
  if (!sale) return <p className="text-sm text-muted">{t("loading")}</p>;

  const money = (minor: string) => formatCurrency(BigInt(minor), sale.currency, locale);
  const receiptUrl = typeof window === "undefined" ? sale.receiptPath : `${window.location.origin}${sale.receiptPath}`;
  const canVoid = can(access, Permission.SALES_VOID) && sale.status === "completed" && !sale.historyOnly;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={sale.number ?? sale.externalRef ?? t("historyRecord")}
        description={[formatWhen(sale.soldAt, locale, "Africa/Lagos"), sale.byName, sale.branchName].filter(Boolean).join(" · ")}
        actions={
          <Link href="/app/sales" className="text-sm font-medium text-primary">
            {t("allSales")}
          </Link>
        }
      />
      <div className="flex flex-wrap gap-2">
        {sale.status === "voided" ? <Badge tone="danger">{t("voided")}</Badge> : <Badge tone="success">{t("completed")}</Badge>}
        {sale.historyOnly ? <Badge>{t("history")}</Badge> : null}
        {sale.provisionalNumber ? <Badge tone="info">{t("offlineNumber", { number: sale.provisionalNumber })}</Badge> : null}
        {sale.source === "import" ? <Badge>{t("imported")}</Badge> : null}
      </div>
      {sale.historyOnly ? <p className="text-sm text-muted">{t("historyExplain")}</p> : null}
      {sale.voidReason ? <p className="text-sm text-danger">{t("voidedBecause", { reason: sale.voidReason })}</p> : null}
      <Card>
        <ul className="divide-y divide-border">
          {sale.lines.map((line, index) => (
            <li key={index} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span>
                <span className="block font-medium">{line.description}</span>
                <span className="text-muted">
                  {t("lineDetail", {
                    quantity: quantityToString(BigInt(line.enteredQuantity)),
                    unit: unitName(line.enteredUnit, Number(quantityToString(BigInt(line.enteredQuantity))) === 1 ? 1 : 2),
                    price: money(line.unitPriceMinor),
                  })}
                </span>
                {line.costMinor !== undefined ? <span className="block text-xs text-muted">{t("lineCost", { cost: money(line.costMinor) })}</span> : null}
              </span>
              <span className="tabular-nums">{money(line.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-border pt-3 text-sm">
          {BigInt(sale.discountMinor) > 0n ? (
            <>
              <dt className="text-muted">{t("discount")}</dt>
              <dd className="text-right tabular-nums">{money((-BigInt(sale.discountMinor)).toString())}</dd>
            </>
          ) : null}
          <dt className="font-medium">{t("total")}</dt>
          <dd className="text-right font-medium tabular-nums">{money(sale.totalMinor)}</dd>
          {sale.payments.map((payment, index) => (
            <Fragment key={index}>
              <dt className="text-muted">{t(`mode.${payment.method}`)}</dt>
              <dd className="text-right tabular-nums">{money(payment.amountMinor)}</dd>
            </Fragment>
          ))}
          {BigInt(sale.balanceMinor) > 0n ? (
            <>
              <dt className="text-warning">{t("owing")}</dt>
              <dd className="text-right tabular-nums text-warning">{money(sale.balanceMinor)}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      {sale.customerName ? (
        <p className="text-sm">
          {sale.customerPhoneLast4 ? t("customerWithPhone", { name: sale.customerName, last4: sale.customerPhoneLast4 }) : t("customerName", { name: sale.customerName })}
        </p>
      ) : null}
      {sale.note ? <p className="text-sm text-muted">{sale.note}</p> : null}
      {sale.number ? (
        <div className="flex flex-wrap gap-3">
          <a href={whatsAppLink(sale, typeof window === "undefined" ? "" : window.location.origin)} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-fg">
            {sale.whatsApp.phone ? t("sendWhatsAppCustomer") : t("sendWhatsApp")}
          </a>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(receiptUrl).then(() => setCopied(true));
            }}
          >
            {copied ? t("copied") : t("copyLink")}
          </Button>
          <Link href={sale.receiptPath} className="self-center text-sm text-primary" target="_blank">
            {t("viewReceipt")}
          </Link>
        </div>
      ) : null}
      {canVoid ? (
        voiding ? (
          <Card>
            <SafeForm className="space-y-3" pending={pending} onSubmit={() => void cancelSale()}>
              <p className="text-sm">{t("voidExplain")}</p>
              <FormField id="void-reason" label={t("voidReason")}>
                <Input id="void-reason" value={reason} required maxLength={200} onChange={(event) => setReason(event.target.value)} />
              </FormField>
              {error ? (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}
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
    <RequireAccess anyOf={[Permission.SALES_CREATE, Permission.SALES_READ_OWN, Permission.SALES_READ_ALL]}>
      <SaleScreen />
    </RequireAccess>
  );
}
