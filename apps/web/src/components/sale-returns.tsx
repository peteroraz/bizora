"use client";

import { IDEMPOTENCY_HEADER, quantityToString, typeNumber, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { formatCurrency, formatWhen } from "../i18n/format";
import { api } from "../lib/api";
import type { SaleDetail, SaleReturn } from "../lib/sales-client";
import { ActionLink } from "./action-link";
import { useUnitName } from "./stock-quantity";
import { SentenceInput } from "./typing";
import { usePlace } from "../lib/access-context";

type Choice = { quantity: string; backToStock: boolean };

/** Quantities are thousandths; the box shows what is left as people type it. */
const asText = (thousandths: bigint) => quantityToString(thousandths);
const toThousandths = (text: string) => {
  const [whole = "0", fraction = ""] = text.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 3) return null;
  return BigInt(whole || "0") * 1000n + BigInt((fraction + "000").slice(0, 3));
};

/** The returns already recorded on a sale (ADR-030). */
export function SaleReturnsList({ sale }: { sale: SaleDetail }) {
  const t = useTranslations("sales.returns");
  const locale = useLocale();
  const { timezone: timeZone } = usePlace();
  const unitName = useUnitName();
  if (sale.returns.length === 0) return null;
  const money = (minor: string) => formatCurrency(BigInt(minor), sale.currency, locale);
  const lineName = new Map(sale.lines.map((line) => [line.id, line.description]));
  return (
    <Card>
      <p className="mb-2 text-sm font-medium">{t("listTitle")}</p>
      <ul className="divide-y divide-border" aria-label={t("listTitle")}>
        {sale.returns.map((item) => (
          <li key={item.id} className="space-y-1 py-2 text-sm" data-testid="sale-return">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{item.number}</span>
              <span className="tabular-nums">{money(item.totalMinor)}</span>
            </div>
            <ul className="text-muted">
              {item.lines.map((line) => (
                <li key={line.saleLineId}>
                  {t("lineBack", {
                    quantity: asText(BigInt(line.enteredQuantity)),
                    unit: unitName(line.enteredUnit, BigInt(line.enteredQuantity) === 1000n ? 1 : 2),
                    item: lineName.get(line.saleLineId) ?? "",
                  })}{" "}
                  {line.backToStock ? t("backOnShelf") : t("notBackOnShelf")}
                </li>
              ))}
            </ul>
            <p className="text-muted">{moneyLine(item, money, t)}</p>
            <p className="text-muted">{t("byLine", { reason: item.reason, name: item.byName ?? t("someone"), when: formatWhen(item.createdAt, locale, timeZone) })}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function moneyLine(item: SaleReturn, money: (minor: string) => string, t: ReturnType<typeof useTranslations<"sales.returns">>) {
  const off = BigInt(item.offBalanceMinor) > 0n;
  const back = BigInt(item.refundMinor) > 0n;
  if (off && back) return t("offAndBack", { off: money(item.offBalanceMinor), back: money(item.refundMinor), method: t(`method.${item.refundMethod}`) });
  if (off) return t("offOnly", { off: money(item.offBalanceMinor) });
  return t("backOnly", { back: money(item.refundMinor), method: t(`method.${item.refundMethod}`) });
}

/** Take goods back from a customer: pick how many of each item, whether they go back on the shelf, and how the money goes back. */
export function SaleReturnPanel({ sale, onDone }: { sale: SaleDetail; onDone: (next: SaleDetail) => void }) {
  const t = useTranslations("sales.returns");
  const locale = useLocale();
  const unitName = useUnitName();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [refundMethod, setRefundMethod] = useState<"cash" | "transfer">("cash");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => uuidv7());

  const returnable = useMemo(
    () =>
      sale.lines
        .map((line) => ({ line, left: BigInt(line.enteredQuantity) - BigInt(line.returnedQuantity) }))
        .filter((item) => item.left > 0n),
    [sale.lines],
  );
  if (returnable.length === 0) return null;
  const money = (minor: bigint) => formatCurrency(minor, sale.currency, locale);

  // What the chosen goods are worth: the line's share after the sale discount, as the server works it out.
  const subtotal = sale.lines.reduce((sum, line) => sum + BigInt(line.lineTotalMinor), 0n);
  const discount = BigInt(sale.discountMinor);
  const worth = returnable.reduce((sum, { line }) => {
    const chosen = toThousandths(choices[line.id]?.quantity ?? "");
    if (!chosen) return sum;
    const lineTotal = BigInt(line.lineTotalMinor);
    const net = subtotal > 0n ? lineTotal - (discount * lineTotal) / subtotal : lineTotal;
    return sum + (net * chosen) / BigInt(line.enteredQuantity);
  }, 0n);
  const owed = BigInt(sale.balanceMinor);
  const offBalance = worth < owed ? worth : owed;
  const refund = worth - offBalance;

  function choose(lineId: string, change: Partial<Choice>) {
    setChoices((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? { quantity: "", backToStock: true }), ...change } }));
  }

  async function submit() {
    setError(null);
    const lines = returnable
      .map(({ line, left }) => ({ line, left, chosen: toThousandths(choices[line.id]?.quantity ?? "") }))
      .filter((item) => item.chosen !== null && item.chosen > 0n);
    if (lines.length === 0) {
      setError(t("pickSomething"));
      return;
    }
    const tooMany = lines.find((item) => (item.chosen ?? 0n) > item.left);
    if (tooMany) {
      setError(t("tooMany", { item: tooMany.line.description, left: asText(tooMany.left) }));
      return;
    }
    setPending(true);
    const response = await api(`/api/v1/sales/${sale.id}/returns`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: requestId },
      body: JSON.stringify({
        id: requestId,
        lines: lines.map((item) => ({ saleLineId: item.line.id, quantity: asText(item.chosen ?? 0n), backToStock: choices[item.line.id]?.backToStock ?? true })),
        refundMethod,
        reason: reason.trim(),
      }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) {
      setOpen(false);
      setChoices({});
      setReason("");
      setRequestId(uuidv7());
      onDone(payload.data.sale);
      return;
    }
    setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
  }

  const swapHref = sale.customerId
    ? `/app/sales/new?customer=${encodeURIComponent(sale.customerId)}&name=${encodeURIComponent(sale.customerName ?? "")}&swap=${encodeURIComponent(sale.number ?? "")}`
    : `/app/sales/new?swap=${encodeURIComponent(sale.number ?? "")}`;

  if (!open) {
    return (
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="return-goods">
          {t("open")}
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void submit()}>
        <div>
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="text-sm text-muted">{t("lead")}</p>
        </div>
        <ul className="space-y-3">
          {returnable.map(({ line, left }) => {
            const choice = choices[line.id];
            const unit = unitName(line.enteredUnit, 2);
            return (
              <li key={line.id} className="space-y-2 rounded-md border border-border p-3">
                <FormField id={`return-${line.id}`} label={line.description} hint={t("canComeBack", { left: asText(left), unit })}>
                  <Input
                    id={`return-${line.id}`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={choice?.quantity ?? ""}
                    onChange={(event) => choose(line.id, { quantity: typeNumber(event.target.value, 3) })}
                  />
                </FormField>
                {line.productId ? (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={choice?.backToStock ?? true}
                      onChange={(event) => choose(line.id, { backToStock: event.target.checked })}
                    />
                    {t("backToStock")}
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
        {worth > 0n ? (
          <p className="text-sm" data-testid="return-worth">
            {offBalance > 0n && refund > 0n
              ? t("willOffAndBack", { worth: money(worth), off: money(offBalance), back: money(refund) })
              : offBalance > 0n
                ? t("willOffOnly", { worth: money(worth) })
                : t("willBackOnly", { worth: money(worth) })}
          </p>
        ) : null}
        {refund > 0n || worth === 0n ? (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("howBack")}</legend>
            <div className="flex flex-wrap gap-4">
              {(["cash", "transfer"] as const).map((method) => (
                <label key={method} className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="refund-method" className="h-5 w-5" checked={refundMethod === method} onChange={() => setRefundMethod(method)} />
                  {t(`method.${method}`)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <FormField id="return-reason" label={t("reason")} hint={t("reasonHint")}>
          <SentenceInput id="return-reason" value={reason} required minLength={3} maxLength={240} onChange={(event) => setReason(event.target.value)} />
        </FormField>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending} pendingLabel={t("saving")}>
            {t("confirm")}
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
        </div>
        <p className="text-sm text-muted">
          {t("swapLead")}{" "}
          <ActionLink href={swapHref} variant="ghost" data-testid="swap-goods">
            {t("swap")}
          </ActionLink>
        </p>
      </SafeForm>
    </Card>
  );
}
