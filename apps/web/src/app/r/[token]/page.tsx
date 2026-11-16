import { quantityToString } from "@bizora/contracts";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { formatCurrency, formatWhen } from "../../../i18n/format";

/** A receipt anyone with the WhatsApp link can open, without signing in. It shows only what is on the receipt. */
type Receipt = {
  businessName: string;
  branchName: string;
  customerName: string | null;
  number: string | null;
  provisionalNumber: string | null;
  status: "completed" | "voided";
  soldAt: string;
  currency: string;
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  paidMinor: string;
  balanceMinor: string;
  lines: { description: string; enteredQuantity: string; enteredUnit: string; unitPriceMinor: string; lineTotalMinor: string }[];
  payments: { method: "cash" | "transfer" | "pos"; amountMinor: string }[];
};

const origin = process.env.API_ORIGIN ?? "http://localhost:3001";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();
  const response = await fetch(`${origin}/api/v1/public/receipts/${token}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) notFound();
  const receipt = ((await response.json()) as { data: { receipt: Receipt } }).data.receipt;
  const t = await getTranslations("receipt");
  const units = await getTranslations("units");
  const locale = await getLocale();
  const money = (minor: string) => formatCurrency(BigInt(minor), receipt.currency, locale);

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">{receipt.businessName}</h1>
        <p className="text-sm text-muted">{receipt.branchName}</p>
      </header>
      <p className="text-sm">
        {t("number", { number: receipt.number ?? "" })}
        {receipt.provisionalNumber ? ` · ${t("offlineNumber", { number: receipt.provisionalNumber })}` : ""}
        <br />
        {formatWhen(receipt.soldAt, locale, "Africa/Lagos")}
      </p>
      {receipt.status === "voided" ? (
        <p className="rounded-card border border-danger bg-danger-bg px-3 py-2 text-sm text-danger" role="status">
          {t("voided")}
        </p>
      ) : null}
      {receipt.customerName ? <p className="text-sm">{t("customer", { name: receipt.customerName })}</p> : null}
      <ul className="divide-y divide-border border-y border-border">
        {receipt.lines.map((line, index) => {
          const quantity = quantityToString(BigInt(line.enteredQuantity));
          const unit = units.has(line.enteredUnit) ? units(line.enteredUnit, { count: Number(quantity) === 1 ? 1 : 2 }) : line.enteredUnit;
          return (
            <li key={index} className="flex justify-between gap-3 py-2 text-sm">
              <span>
                <span className="block font-medium">{line.description}</span>
                <span className="text-muted">{t("line", { quantity, unit, price: money(line.unitPriceMinor) })}</span>
              </span>
              <span className="tabular-nums">{money(line.lineTotalMinor)}</span>
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-2 gap-1 text-sm">
        {BigInt(receipt.discountMinor) > 0n ? (
          <>
            <dt className="text-muted">{t("discount")}</dt>
            <dd className="text-right tabular-nums">{money((-BigInt(receipt.discountMinor)).toString())}</dd>
          </>
        ) : null}
        <dt className="font-medium">{t("total")}</dt>
        <dd className="text-right font-medium tabular-nums">{money(receipt.totalMinor)}</dd>
        {receipt.payments.map((payment, index) => (
          <Fragment key={index}>
            <dt className="text-muted">{t(`method.${payment.method}`)}</dt>
            <dd className="text-right tabular-nums">{money(payment.amountMinor)}</dd>
          </Fragment>
        ))}
        {BigInt(receipt.balanceMinor) > 0n ? (
          <>
            <dt className="text-warning">{t("owing")}</dt>
            <dd className="text-right tabular-nums">{money(receipt.balanceMinor)}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted">{t("footer")}</p>
    </main>
  );
}
