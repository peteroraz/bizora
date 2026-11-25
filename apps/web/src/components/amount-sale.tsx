"use client";

import { IDEMPOTENCY_HEADER, parseAmount, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCurrency } from "../i18n/format";
import { api } from "../lib/api";
import { enqueue, type OutboxOwner } from "../lib/offline/outbox";
import { isNetworkFailure } from "../lib/offline/sync";
import { nextProvisionalNumber } from "../lib/provisional";

type Method = "cash" | "transfer" | "pos";
const METHODS: Method[] = ["cash", "transfer", "pos"];
type Recorded = { number: string; saleId: string | null; minor: bigint; method: Method; offline: boolean };

/**
 * Just the amount (ADR-069): the sale comes to ₦3,500, paid in cash. No item, quantity or price. What it was for is
 * optional and stays on the sale only. Works with no network like any other sale; the pad stays open for the next one.
 */
export default function AmountSale({ owner, currency, onClose }: { owner: OutboxOwner | null; currency: string; onClose: () => void }) {
  const t = useTranslations("amountSale");
  const ts = useTranslations("sales");
  const locale = useLocale();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [what, setWhat] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const focusAmount = () => document.getElementById("amount-sale-amount")?.focus();
  useEffect(focusAmount, []);
  const minor = amount.trim() ? parseAmount(amount, currency) : null;
  const money = (value: bigint) => formatCurrency(value, currency, locale);

  function done(result: Recorded) {
    setRecorded(result);
    setAmount("");
    setWhat("");
    setMethod("cash");
    focusAmount();
  }

  async function record() {
    setError(null);
    setRecorded(null);
    if (minor === null || minor <= 0n) {
      setError(t("enterAmount"));
      focusAmount();
      return;
    }
    const id = uuidv7();
    const description = what.trim();
    const body = {
      id,
      lines: [{ amountMinor: minor.toString(), ...(description ? { description } : {}) }],
      payments: [{ method, amountMinor: minor.toString() }],
    };
    setPending(true);
    try {
      const response = await api("/api/v1/sales", { method: "POST", headers: { [IDEMPOTENCY_HEADER]: id }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? ts("failed"));
        return;
      }
      done({ number: payload.data.sale.saleNumber ?? "", saleId: payload.data.sale.id, minor, method, offline: false });
    } catch (failure) {
      if (isNetworkFailure(failure) && owner) {
        const number = nextProvisionalNumber();
        await enqueue(
          owner,
          "sale.create",
          { ...body, provisionalNumber: number, soldAt: new Date().toISOString() },
          { meta: { summary: description || t("sale"), totalMinor: minor.toString(), currency, customerName: null, source: "counter", number } },
        );
        done({ number, saleId: null, minor, method, offline: true });
      } else {
        setError(ts("failed"));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="amount-sale">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void record();
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <p className="text-sm text-muted">{t("lead")}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
        {recorded ? (
          <p className={`rounded-card border px-4 py-3 text-sm ${recorded.offline ? "border-warning bg-warning-bg text-warning" : "border-success bg-success-bg text-success"}`} role="status" data-testid="amount-recorded">
            {recorded.offline
              ? t("savedOffline", { number: recorded.number, amount: money(recorded.minor), method: ts(`mode.${recorded.method}`) })
              : t("recorded", { number: recorded.number, amount: money(recorded.minor), method: ts(`mode.${recorded.method}`) })}{" "}
            {recorded.saleId ? (
              <Link href={`/app/sales/${recorded.saleId}`} className="inline-flex min-h-11 items-center font-medium underline">
                {t("open")}
              </Link>
            ) : null}
          </p>
        ) : null}
        <FormField id="amount-sale-amount" label={t("amount")}>
          <Input
            id="amount-sale-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-14 text-2xl font-semibold"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d.,]/g, "").slice(0, 16))}
          />
        </FormField>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{ts("paidWith")}</legend>
          <div className="flex flex-wrap gap-2">
            {METHODS.map((option) => (
              <Button key={option} type="button" size="md" variant={method === option ? "primary" : "secondary"} aria-pressed={method === option} onClick={() => setMethod(option)}>
                {ts(`mode.${option}`)}
              </Button>
            ))}
          </div>
        </fieldset>
        <FormField id="amount-sale-what" label={t("what")} hint={t("whatHint")}>
          <Input id="amount-sale-what" maxLength={160} autoCapitalize="sentences" value={what} onChange={(event) => setWhat(event.target.value)} />
        </FormField>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {minor !== null && minor > 0n ? t("recordAmount", { amount: money(minor) }) : t("record")}
        </Button>
      </form>
    </Card>
  );
}
