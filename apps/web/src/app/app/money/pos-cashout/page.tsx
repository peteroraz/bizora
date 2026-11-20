"use client";

import { IDEMPOTENCY_HEADER, Permission, parseAmount, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { AmountInput, SentenceInput } from "../../../../components/typing";
import { dayKey, formatCurrency } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";

/**
 * POS cash-out (ADR-038): the customer pays on the shop's POS machine (Moniepoint, OPay and the like) and gets cash
 * from the drawer. The drawer goes down, the POS money goes up, and only the fee is profit.
 */
function PosCashoutScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const place = usePlace();
  const today = dayKey(new Date(), place.timezone);
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [feePaidBy, setFeePaidBy] = useState<"pos" | "cash">("pos");
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [id, setId] = useState(() => uuidv7());

  const cashMinor = parseAmount(amount, place.currency);
  const feeMinor = fee.trim() ? parseAmount(fee, place.currency) : 0n;
  const money = (minor: bigint) => formatCurrency(minor, place.currency, locale);
  const ready = cashMinor !== null && cashMinor > 0n && feeMinor !== null && feeMinor >= 0n;
  const tooHigh = ready && feeMinor > cashMinor;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!ready) return setError(t("invalidAmount"));
    if (tooHigh) return setError(t("posCashout.feeTooHigh"));
    setPending(true);
    try {
      const response = await api("/api/v1/money/pos-cashouts", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({ id, amountMinor: cashMinor.toString(), feeMinor: feeMinor.toString(), feePaidBy, movementDate: day, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      setSaved(t("posCashout.saved", { amount: money(cashMinor), fee: money(feeMinor) }));
      // Ready for the next customer.
      setAmount("");
      setFee("");
      setNote("");
      setId(uuidv7());
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("posCashout.title")} intro={t("posCashout.lead")} />
      {saved ? (
        <p className="rounded-control border border-success bg-success-bg px-3 py-2 text-sm text-success" role="status" data-testid="pos-cashout-saved">
          {saved}
        </p>
      ) : null}
      <Card>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <FormField id="cashout-amount" label={t("posCashout.amount")}>
            <AmountInput currency={place.currency} id="cashout-amount" value={amount} onChange={(event) => { setAmount(event.target.value); setSaved(null); }} required />
          </FormField>
          <FormField id="cashout-fee" label={t("posCashout.fee")} hint={t("posCashout.feeHint")} {...(tooHigh ? { error: t("posCashout.feeTooHigh") } : {})}>
            <AmountInput currency={place.currency} id="cashout-fee" value={fee} onChange={(event) => setFee(event.target.value)} />
          </FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("posCashout.feePaidBy")}</legend>
            {(["pos", "cash"] as const).map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-3 rounded-control border border-border px-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="feePaidBy" value={option} checked={feePaidBy === option} onChange={() => setFeePaidBy(option)} />
                {option === "pos" ? t("posCashout.feeOnPos") : t("posCashout.feeInCash")}
              </label>
            ))}
          </fieldset>
          {ready && !tooHigh ? (
            <p className="rounded-control bg-sidebar px-3 py-2 text-sm" data-testid="pos-cashout-summary">
              {t("posCashout.summary", {
                pos: money(feePaidBy === "pos" ? cashMinor + feeMinor : cashMinor),
                drawer: money(feePaidBy === "pos" ? cashMinor : cashMinor - feeMinor),
              })}
            </p>
          ) : null}
          <FormField id="cashout-day" label={t("date")}>
            <Input id="cashout-day" type="date" max={today} value={day} onChange={(event) => setDay(event.target.value || today)} required />
          </FormField>
          <FormField id="cashout-note" label={t("note")} hint={t("noteHint")}>
            <SentenceInput id="cashout-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          {error ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? t("saving") : t("posCashout.save")}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function PosCashoutPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_COLLECT]}>
      <PosCashoutScreen />
    </RequireAccess>
  );
}
