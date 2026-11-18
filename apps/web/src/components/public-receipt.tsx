import { quantityToString } from "@bizora/contracts";
import { getLocale, getTranslations } from "next-intl/server";
import { Fragment } from "react";
import { ShopHeading, ShopMessage } from "./shop-heading";
import { formatCurrency, formatDay, formatWhen } from "../i18n/format";

/** A receipt anyone with the WhatsApp link can open, without signing in. It shows only what is on the receipt. */
export type Receipt = {
  businessName: string;
  branchName: string;
  shop?: { phone: string | null; address: string | null };
  message?: string | null;
  hasLogo?: boolean;
  handle?: string | null;
  color?: string | null;
  customerName: string | null;
  number: string | null;
  invoiceNumber: string | null;
  provisionalNumber: string | null;
  dueDate: string | null;
  documents: ("invoice" | "receipt")[];
  status: "awaiting_payment" | "awaiting_release" | "completed" | "voided";
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


/** Loads a receipt by its token, or null when there is none. */
export async function loadReceipt(token: string): Promise<Receipt | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const response = await fetch(`${origin}/api/v1/public/receipts/${token}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  return ((await response.json()) as { data: { receipt: Receipt } }).data.receipt;
}

export async function ReceiptView({ token, receipt }: { token: string; receipt: Receipt }) {
  const t = await getTranslations("receipt");
  const units = await getTranslations("units");
  const locale = await getLocale();
  const money = (minor: string) => formatCurrency(BigInt(minor), receipt.currency, locale);

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <ShopHeading
        name={receipt.businessName}
        place={receipt.branchName}
        address={receipt.shop?.address}
        phone={receipt.shop?.phone}
        logoSrc={receipt.hasLogo ? `/api/v1/public/receipts/${token}/logo` : null}
        color={receipt.color}
        profileHref={receipt.handle ? `/${receipt.handle}` : null}
      />
      <p className="text-sm">
        {receipt.number ? t("number", { number: receipt.number }) : t("invoiceNumber", { number: receipt.invoiceNumber ?? "" })}
        {receipt.number && receipt.invoiceNumber ? ` · ${t("invoiceNumber", { number: receipt.invoiceNumber })}` : ""}
        {receipt.provisionalNumber ? ` · ${t("offlineNumber", { number: receipt.provisionalNumber })}` : ""}
        <br />
        {formatWhen(receipt.soldAt, locale, Intl.DateTimeFormat().resolvedOptions().timeZone)}
      </p>
      {receipt.status === "voided" ? (
        <p className="rounded-card border border-danger bg-danger-bg px-3 py-2 text-sm text-danger" role="status">
          {t("voided")}
        </p>
      ) : null}
      {receipt.status === "awaiting_payment" ? (
        <p className="rounded-card border border-warning bg-warning-bg px-3 py-2 text-sm text-warning" role="status">
          {t("unpaid")}
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
        {receipt.dueDate && receipt.status !== "awaiting_payment" ? (
          <>
            <dt className="text-muted">{t("due")}</dt>
            <dd className="text-right">{formatDay(receipt.dueDate, locale)}</dd>
          </>
        ) : null}
      </dl>
      <ShopMessage title={BigInt(receipt.balanceMinor) > 0n || receipt.status === "awaiting_payment" ? t("howToPay") : t("fromShop")} text={receipt.message ?? null} />
      {receipt.documents.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {receipt.documents.map((type) => (
            <a
              key={type}
              href={`/api/v1/public/receipts/${token}/documents/${type}.pdf`}
              className="inline-flex items-center rounded-control border border-border px-3 py-2 text-sm font-medium text-primary"
            >
              {t(type === "receipt" ? "downloadReceipt" : BigInt(receipt.balanceMinor) > 0n && receipt.status !== "awaiting_payment" ? "downloadCreditInvoice" : "downloadInvoice")}
            </a>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-muted">
        {t("footer")}{" "}
        <a href="/" className="text-primary">
          {t("footerLink")}
        </a>
      </p>
    </main>
  );
}
