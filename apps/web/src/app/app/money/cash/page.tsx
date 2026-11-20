"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ActionLink, BackLink } from "../../../../components/action-link";
import { DaySwitcher } from "../../../../components/day-switcher";
import { RequireAccess } from "../../../../components/require-access";
import { SentenceInput } from "../../../../components/typing";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf, type CashPosition, type MoneyMove } from "../../../../lib/money-client";

/**
 * The cash in each shop's drawer on a day: what was there at the start, what came in and went out and why, what
 * should be there, the counts and their differences, and money moved in or out (ADR-028).
 */
function CashScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const counts = can(access, Permission.CASH_CLOSE);
  const records = can(access, Permission.EXPENSES_RECORD);
  const approves = can(access, Permission.EXPENSES_APPROVE);
  const [position, setPosition] = useState<CashPosition | null>(null);
  const [day, setDay] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date: string) => {
    const response = await api(`/api/v1/money/cash${date ? `?date=${date}` : ""}`).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()).data as CashPosition;
    setPosition(data);
    setDay(data.date);
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  async function cancelMove(move: MoneyMove) {
    setError(null);
    const response = await api(`/api/v1/money/movements/${move.id}/void`, { method: "POST", body: JSON.stringify({ reason }) }).catch(() => null);
    if (!response?.ok) {
      setError(response ? await problemOf(response, t("failed")) : t("failed"));
      return;
    }
    setCancelling(null);
    setReason("");
    await load(day);
  }

  const money = (minor: string | bigint) => (position ? formatCurrency(BigInt(minor), position.currency, locale) : "");
  const isToday = position ? position.date === position.today : true;

  return (
    <div className="space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader
        title={t("cash.title")}
        intro={t("cash.lead")}
        actions={
          records ? (
            <ActionLink href="/app/money/move" size="sm">
              {t("recordMove")}
            </ActionLink>
          ) : undefined
        }
      />
      {position ? (
        <DaySwitcher
          day={day}
          today={position.today}
          onChange={(next) => {
            setDay(next);
            void load(next);
          }}
        />
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {position?.shops.map((shop) => (
          <Card key={shop.branchId} className="space-y-4" data-testid="cash-shop">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{shop.name}</p>
                <p className="text-sm text-muted">{isToday ? t("cash.expected") : t("cash.expectedEnd")}</p>
                <p className="text-2xl font-semibold tabular-nums" data-testid="cash-expected">
                  {money(shop.expectedMinor)}
                </p>
              </div>
              {counts && isToday ? (
                <ActionLink href={`/app/money/cash/count?shop=${shop.branchId}`} variant="primary" size="sm">
                  {t("cash.countAction")}
                </ActionLink>
              ) : null}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t("cash.opening")}</dt>
                <dd className="tabular-nums">{money(shop.openingMinor)}</dd>
              </div>
              {shop.flows.length === 0 ? <p className="text-muted">{t("cash.nothing")}</p> : null}
              {shop.flows.map((flow) => {
                const net = BigInt(flow.inMinor) - BigInt(flow.outMinor);
                return (
                  <div key={flow.kind} className="flex justify-between gap-3" data-testid={`cash-flow-${flow.kind}`}>
                    <dt>{t(`cash.flow_${flow.kind}`)}</dt>
                    <dd className={`tabular-nums ${net < 0n ? "text-danger" : ""}`}>
                      {net < 0n ? "−" : "+"}
                      {money(net < 0n ? -net : net)}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {shop.counts.length > 0 ? (
              <div>
                <p className="text-sm font-medium">{t("cash.counts")}</p>
                <ul className="mt-1 space-y-1 text-sm" data-testid="cash-counts">
                  {shop.counts.map((count) => {
                    const difference = BigInt(count.differenceMinor);
                    return (
                      <li key={count.id}>
                        <span className="text-muted">
                          {t("cash.countLine", { time: formatWhen(count.at, locale, place.timezone), counted: money(count.countedMinor), expected: money(count.expectedMinor) })}
                          {count.by ? ` · ${count.by}` : ""}
                        </span>{" "}
                        <span className={difference < 0n ? "font-medium text-danger" : difference > 0n ? "font-medium text-warning" : "text-success"}>
                          {difference < 0n
                            ? t("cash.short", { amount: money(-difference) })
                            : difference > 0n
                              ? t("cash.over", { amount: money(difference) })
                              : t("cash.matches")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {shop.moves.length > 0 ? (
              <div>
                <p className="text-sm font-medium">{t("cash.moves")}</p>
                <ul className="mt-1 space-y-2 text-sm">
                  {shop.moves.map((move) => (
                    <li key={move.id}>
                      <div className="flex justify-between gap-3">
                        <span className={move.status === "voided" ? "text-muted line-through" : ""}>
                          {t(`move.kind_${move.kind}`)}
                          {move.kind === "pos_cashout" && move.feeMinor !== "0"
                            ? ` ${t(move.feePaidBy === "cash" ? "posCashout.feeInCashShort" : "posCashout.feeOnPosShort", { amount: money(move.feeMinor) })}`
                            : ""}
                          {move.note ? `: ${move.note}` : ""}
                        </span>
                        <span className="tabular-nums">{money(move.amountMinor)}</span>
                      </div>
                      {approves && move.status === "recorded" ? (
                        cancelling === move.id ? (
                          <div className="mt-2 space-y-2">
                            <SentenceInput aria-label={t("reason")} placeholder={t("reasonHint")} value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} />
                            <div className="flex gap-2">
                              <Button type="button" variant="danger" size="sm" disabled={reason.trim().length < 3} onClick={() => void cancelMove(move)}>
                                {t("cancel")}
                              </Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => setCancelling(null)}>
                                {t("back")}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" className="text-xs text-primary" onClick={() => setCancelling(move.id)}>
                            {t("cancel")}
                          </button>
                        )
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function CashPage() {
  return (
    <RequireAccess anyOf={[Permission.CASH_EXPECTED_READ]}>
      <CashScreen />
    </RequireAccess>
  );
}
