"use client";

import { IDEMPOTENCY_HEADER, MONEY_MOVEMENT_KINDS, Permission, parseAmount, uuidv7, type MoneyMovementKind } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { AmountInput, SentenceInput } from "../../../../components/typing";
import { dayKey } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";

/** The owner's money in or out of the drawer, and cash moved to or from the bank (ADR-028). */
function MoveScreen() {
  const t = useTranslations("money");
  const router = useRouter();
  const access = useAccess();
  const place = usePlace();
  const today = dayKey(new Date(), place.timezone);
  const [kind, setKind] = useState<MoneyMovementKind>("to_bank");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [id] = useState(() => uuidv7());

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const minor = parseAmount(amount, place.currency);
    if (minor === null || minor <= 0n) return setError(t("invalidAmount"));
    setPending(true);
    try {
      const response = await api("/api/v1/money/movements", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({ id, kind, amountMinor: minor.toString(), movementDate: day, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      router.push(can(access, Permission.CASH_EXPECTED_READ) ? "/app/money/cash" : "/app/money");
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("move.title")} intro={t("moveLead")} />
      <Card>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("move.kind")}</legend>
            {MONEY_MOVEMENT_KINDS.map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-3 rounded-control border border-border px-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="kind" value={option} checked={kind === option} onChange={() => setKind(option)} />
                {t(`move.kind_${option}`)}
              </label>
            ))}
          </fieldset>
          <FormField id="move-amount" label={t("amount")}>
            <AmountInput currency={place.currency} id="move-amount" value={amount} onChange={(event) => setAmount(event.target.value)} required />
          </FormField>
          <FormField id="move-day" label={t("date")}>
            <Input id="move-day" type="date" max={today} value={day} onChange={(event) => setDay(event.target.value || today)} required />
          </FormField>
          <FormField id="move-note" label={t("note")} hint={t("noteHint")}>
            <SentenceInput id="move-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          {error ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function MovePage() {
  return (
    <RequireAccess anyOf={[Permission.EXPENSES_RECORD]}>
      <MoveScreen />
    </RequireAccess>
  );
}
