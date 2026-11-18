"use client";

import { IDEMPOTENCY_HEADER, Permission, uuidv7 } from "@bizora/contracts";
import { Button, Card, EmptyState, FormField, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { SentenceInput } from "../../../../components/typing";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import type { TransferItem, TransferList } from "../../../../lib/money-client";

/** Transfers waiting for confirmation (ADR-031): check each one against the bank before it counts as money in. */
function TransfersScreen() {
  const t = useTranslations("money.transfers");
  const locale = useLocale();
  const place = usePlace();
  const [list, setList] = useState<TransferList | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api("/api/v1/transfers").catch(() => null);
    if (!response?.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setList((await response.json()).data as TransferList);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: string) => formatCurrency(BigInt(minor), place.currency, locale);
  const when = (value: string) => formatWhen(value, locale, place.timezone);

  return (
    <div className="space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("title")} intro={t("lead")} />
      {message ? (
        <p className="rounded-control border border-border bg-card px-4 py-3 text-sm" role="status">
          {message}
        </p>
      ) : null}
      {failed ? <p className="text-sm text-danger">{t("loadFailed")}</p> : null}
      {list ? (
        list.waiting.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyBody")} />
        ) : (
          <>
            <p className="text-sm font-medium" data-testid="transfers-waiting-total">
              {t("waitingTotal", { count: list.waitingCount, amount: money(list.waitingMinor) })}
            </p>
            <ul className="space-y-3" aria-label={t("waitingTitle")}>
              {list.waiting.map((item) => (
                <WaitingTransfer
                  key={item.id}
                  item={item}
                  money={money}
                  when={when}
                  onDone={(text) => {
                    setMessage(text);
                    void load();
                  }}
                />
              ))}
            </ul>
          </>
        )
      ) : null}
      {list && list.recent.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">{t("recentTitle")}</p>
          <ul className="divide-y divide-border text-sm" data-testid="transfers-recent">
            {list.recent.map((item) => (
              <li key={item.id} className="space-y-0.5 py-2">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{item.number}</span>
                  <span className="tabular-nums">{money(item.amountMinor)}</span>
                </div>
                <p className={item.confirmation === "not_received" ? "text-danger" : "text-muted"}>
                  {item.confirmation === "not_received"
                    ? item.notReceivedAs === "lost"
                      ? t("recentLost", { name: item.checkedByName ?? t("someone") })
                      : t("recentOwed", { name: item.checkedByName ?? t("someone"), customer: item.customerName ?? "" })
                    : item.confirmedVia === "bank_statement"
                      ? t("recentStatement")
                      : t("recentConfirmed", { name: item.checkedByName ?? t("someone") })}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function WaitingTransfer({ item, money, when, onDone }: { item: TransferItem; money: (minor: string) => string; when: (value: string) => string; onDone: (text: string) => void }) {
  const t = useTranslations("money.transfers");
  const [mode, setMode] = useState<"idle" | "notReceived">("idle");
  const [settle, setSettle] = useState<"owed" | "lost">(item.customerId ? "owed" : "lost");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => uuidv7());
  const base = `/api/v1/transfers/${item.kind}/${item.id}`;

  async function send(path: string, body: Record<string, unknown>, done: string) {
    setPending(true);
    setError(null);
    const response = await api(path, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: `${requestId}-${path.endsWith("confirm") ? "c" : "n"}` }, body: JSON.stringify(body) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) return onDone(done);
    setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
  }

  const who = item.customerName ?? t("walkIn");
  return (
    <li>
      <Card className="space-y-3" data-testid="transfer-waiting">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold tabular-nums">{money(item.amountMinor)}</p>
            <p className="text-sm">{item.kind === "sale_payment" ? t("forSale", { number: item.number ?? "", customer: who }) : t("forDebt", { number: item.number ?? "", customer: who })}</p>
          </div>
          {item.saleId ? (
            <Link href={`/app/sales/${item.saleId}`} className="shrink-0 text-sm font-medium text-primary">
              {t("seeSale")}
            </Link>
          ) : null}
        </div>
        <p className="text-sm text-muted">
          {t("recorded", { name: item.recordedByName ?? t("someone"), when: when(item.recordedAt), shop: item.branchName ?? "" })}
          {item.reference ? ` ${t("reference", { reference: item.reference })}` : ""}
        </p>
        {mode === "idle" ? (
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={pending} onClick={() => void send(`${base}/confirm`, {}, t("confirmedDone", { amount: money(item.amountMinor) }))}>
              {t("cameIn")}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setMode("notReceived")}>
              {t("neverCame")}
            </Button>
          </div>
        ) : (
          <SafeForm
            className="space-y-3"
            pending={pending}
            onSubmit={() =>
              void send(
                `${base}/not-received`,
                item.kind === "sale_payment" ? { settle, reason: reason.trim() } : { reason: reason.trim() },
                settle === "lost" && item.kind === "sale_payment" ? t("lostDone") : t("owedDone", { customer: who }),
              )
            }
          >
            {item.kind === "sale_payment" ? (
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">{t("whatNow")}</legend>
                {item.customerId ? (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="radio" name={`settle-${item.id}`} className="h-5 w-5" checked={settle === "owed"} onChange={() => setSettle("owed")} />
                    {t("settleOwed", { customer: who })}
                  </label>
                ) : null}
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name={`settle-${item.id}`} className="h-5 w-5" checked={settle === "lost"} onChange={() => setSettle("lost")} />
                  {t("settleLost")}
                </label>
              </fieldset>
            ) : (
              <p className="text-sm text-muted">{t("debtOwedAgain", { customer: who })}</p>
            )}
            <FormField id={`reason-${item.id}`} label={t("reason")} hint={t("reasonHint")}>
              <SentenceInput id={`reason-${item.id}`} value={reason} required minLength={3} maxLength={240} onChange={(event) => setReason(event.target.value)} />
            </FormField>
            <div className="flex flex-wrap gap-3">
              <SubmitButton pending={pending} pendingLabel={t("saving")}>
                {t("confirmNeverCame")}
              </SubmitButton>
              <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
                {t("cancel")}
              </Button>
            </div>
          </SafeForm>
        )}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </Card>
    </li>
  );
}

export default function TransfersPage() {
  return (
    <RequireAccess anyOf={[Permission.BANK_RECONCILE]}>
      <TransfersScreen />
    </RequireAccess>
  );
}
