"use client";

import { IDEMPOTENCY_HEADER, Permission, parseAmount, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../../components/action-link";
import { RequireAccess } from "../../../../../components/require-access";
import { AmountInput, SentenceInput } from "../../../../../components/typing";
import { formatCurrency } from "../../../../../i18n/format";
import { can } from "../../../../../lib/access";
import { useAccess, usePlace } from "../../../../../lib/access-context";
import { api } from "../../../../../lib/api";
import { problemOf } from "../../../../../lib/money-client";

/**
 * Counting a drawer (ADR-028). The person counting enters what they counted without seeing what was expected (a
 * blind count). Those who may see the expected cash are told straight away whether it matches.
 */
function CountScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const seesExpected = can(access, Permission.CASH_EXPECTED_READ);
  const [shop, setShop] = useState<string | null>(null);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [id, setId] = useState(() => uuidv7());

  useEffect(() => {
    setShop(new URLSearchParams(window.location.search).get("shop"));
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    const minor = parseAmount(counted || "0", place.currency);
    if (minor === null) return setError(t("invalidAmount"));
    setPending(true);
    try {
      const response = await api("/api/v1/money/cash-counts", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({ id, countedMinor: minor.toString(), ...(shop ? { branchId: shop } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      const count = (await response.json()).data.count as { differenceMinor?: string };
      const difference = count.differenceMinor === undefined ? null : BigInt(count.differenceMinor);
      const amount = (value: bigint) => formatCurrency(value < 0n ? -value : value, place.currency, locale);
      setResult(
        difference === null
          ? t("cash.countSaved")
          : difference < 0n
            ? t("cash.countResultShort", { amount: amount(difference) })
            : difference > 0n
              ? t("cash.countResultOver", { amount: amount(difference) })
              : t("cash.countResultMatch"),
      );
      setCounted("");
      setNote("");
      // A new count starts fresh.
      setId(uuidv7());
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <BackLink href={seesExpected ? "/app/money/cash" : "/app/money"}>{t("back")}</BackLink>
      <PageHeader title={t("countTitle")} intro={t("countLead")} />
      {result ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status" data-testid="count-result">
          {result}
        </p>
      ) : null}
      <Card>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <FormField id="count-amount" label={t("cash.counted")} hint={t("cash.countedHint")}>
            <AmountInput currency={place.currency} id="count-amount" value={counted} onChange={(event) => setCounted(event.target.value)} required />
          </FormField>
          <FormField id="count-note" label={t("note")} hint={t("noteHint")}>
            <SentenceInput id="count-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
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

export default function CountPage() {
  return (
    <RequireAccess anyOf={[Permission.CASH_CLOSE]}>
      <CountScreen />
    </RequireAccess>
  );
}
