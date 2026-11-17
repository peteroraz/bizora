"use client";

import { IDEMPOTENCY_HEADER, Permission, type ReconcileTarget, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, Checkbox, EmptyState, FormField, Input, PageHeader, Select, Tab, TabPanel, TabsRoot } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { formatCurrency } from "../../../../i18n/format";
import { api } from "../../../../lib/api";

type Suggestion = { target: ReconcileTarget; confidence: "exact" | "likely" | "possible"; label: string; detail: Record<string, string | null> };
type Line = {
  id: string;
  accountLabel: string;
  date: string;
  description: string;
  reference: string | null;
  amountMinor: string;
  status: "open" | "matched" | "ignored";
  matchKind: ReconcileTarget["kind"] | null;
  matchDetail: string | null;
  autoMatched: boolean;
  note: string | null;
  customerName: string | null;
  paymentNumber: string | null;
  suggestions?: Suggestion[];
};
type Inbox = { currency: string; items: Line[]; counts: { open: number; openMinor: string; matched: number; ignored: number } };
type Rule = { id: string; pattern: string; target: ReconcileTarget; timesUsed: number };
type Customer = { id: string; name: string; owingMinor: string };

const CHOICES = [
  "debtor",
  "advance",
  "money_in:unrecorded_sales",
  "money_in:owner_capital",
  "money_in:other_income",
  "own_transfer:pos_settlement",
  "own_transfer:cash_deposit",
  "own_transfer:other_account",
  "ignored",
] as const;
type Choice = (typeof CHOICES)[number];

/** A first guess at the words to look for next time: the narration without numbers. */
function patternFrom(description: string) {
  return description
    .replace(/[0-9]+/g, " ")
    .replace(/[^\p{L}\s/&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}

function BankInbox() {
  const t = useTranslations("bank");
  const locale = useLocale();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [classifying, setClassifying] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, saved] = await Promise.all([api(`/api/v1/reconciliation?status=${tab}`), api("/api/v1/reconciliation/rules")]);
    if (list.ok) setInbox((await list.json()).data);
    if (saved.ok) setRules((await saved.json()).data.items);
  }, [tab]);

  useEffect(() => {
    void load().catch(() => setError(t("failed")));
  }, [load, t]);

  const money = (minor: string) => formatCurrency(BigInt(minor), inbox?.currency ?? "NGN", locale);

  function describe(target: ReconcileTarget, detail: Record<string, string | null> = {}): string {
    switch (target.kind) {
      case "recorded_payment":
        return t("target.recorded", { number: detail.number ?? "" });
      case "debtor":
        return detail.customerName ? t("target.debtorNamed", { name: detail.customerName, owing: money(detail.owingMinor ?? "0") }) : t("target.debtor");
      case "advance":
        return t("target.advance");
      case "money_in":
        return t(`category.${target.category}`);
      case "own_transfer":
        return t(`transfer.${target.source}`);
      case "ignored":
        return t("target.ignored");
    }
  }

  function doneText(line: Line) {
    switch (line.matchKind) {
      case "recorded_payment":
        return t("done.recorded");
      case "debtor":
        return t(`done.${line.matchDetail ?? "debt"}`, { name: line.customerName ?? "", number: line.paymentNumber ?? "" });
      case "advance":
        return t("done.advance", { name: line.customerName ?? "" });
      case "money_in":
        return t(`category.${line.matchDetail}`);
      case "own_transfer":
        return t(`transfer.${line.matchDetail}`);
      default:
        return t("done.ignored", { reason: line.note ?? "" });
    }
  }

  async function match(line: Line, target: ReconcileTarget, rulePattern?: string) {
    setError(null);
    setNotice(null);
    setBusy(line.id);
    const key = uuidv7();
    try {
      const response = await api(`/api/v1/reconciliation/${line.id}/match`, {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: key },
        body: JSON.stringify({ target, ...(rulePattern ? { rulePattern } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? t("failed"));
        return;
      }
      setNotice(t("matched", { amount: money(line.amountMinor) }));
      setClassifying(null);
      await load();
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(null);
    }
  }

  async function undo(line: Line) {
    setError(null);
    setBusy(line.id);
    const response = await api(`/api/v1/reconciliation/${line.id}/undo`, { method: "POST" }).catch(() => null);
    setBusy(null);
    if (!response?.ok) {
      setError((await response?.json().catch(() => null))?.error?.message ?? t("failed"));
      return;
    }
    setNotice(t("undone"));
    await load();
  }

  async function deleteRule(id: string) {
    const response = await api(`/api/v1/reconciliation/rules/${id}`, { method: "DELETE" }).catch(() => null);
    if (response?.ok) setRules((current) => current.filter((rule) => rule.id !== id));
  }

  const counts = inbox?.counts;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Link href="/app/money/bank/upload" className="text-sm font-medium text-primary">
            {t("upload")}
          </Link>
        }
      />
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-card border border-danger bg-danger-bg px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <TabsRoot
        value={tab}
        onValueChange={(value) => setTab(value as "open" | "done")}
        label={t("tabsLabel")}
        tabs={
          <>
            <Tab value="open">{t("tabOpen", { count: counts?.open ?? 0 })}</Tab>
            <Tab value="done">{t("tabDone", { count: (counts?.matched ?? 0) + (counts?.ignored ?? 0) })}</Tab>
          </>
        }
      >
        <TabPanel value="open">
          {!inbox ? (
            <p className="text-sm text-muted">{t("loading")}</p>
          ) : inbox.items.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("emptyBody")} />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">{t("openTotal", { count: inbox.counts.open, amount: money(inbox.counts.openMinor) })}</p>
              {inbox.items.map((line) => (
                <Card key={line.id} data-testid="statement-line">
                  <LineHeader line={line} amount={money(line.amountMinor)} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(line.suggestions ?? []).map((suggestion, index) => (
                      <Button key={index} size="sm" className="h-auto min-h-8 py-1 text-left" variant={index === 0 ? "primary" : "secondary"} disabled={busy === line.id} onClick={() => void match(line, suggestion.target)}>
                        {describe(suggestion.target, suggestion.detail)}
                        <span className="ml-1 text-xs opacity-80">· {t(`confidence.${suggestion.confidence}`)}</span>
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => setClassifying(classifying === line.id ? null : line.id)}>
                      {t("other")}
                    </Button>
                  </div>
                  {classifying === line.id ? <Classify line={line} currency={inbox.currency} busy={busy === line.id} onSave={(target, rule) => void match(line, target, rule)} /> : null}
                </Card>
              ))}
            </div>
          )}
        </TabPanel>
        <TabPanel value="done">
          {!inbox ? (
            <p className="text-sm text-muted">{t("loading")}</p>
          ) : inbox.items.length === 0 ? (
            <EmptyState title={t("doneEmptyTitle")} description={t("doneEmptyBody")} />
          ) : (
            <div className="space-y-3">
              {inbox.items.map((line) => (
                <Card key={line.id} data-testid="statement-done">
                  <LineHeader line={line} amount={money(line.amountMinor)} />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      {doneText(line)} {line.autoMatched ? <Badge>{t("auto")}</Badge> : null}
                    </p>
                    <Button size="sm" variant="secondary" disabled={busy === line.id} onClick={() => void undo(line)}>
                      {t("undo")}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabPanel>
      </TabsRoot>
      {rules.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("rulesTitle")}</p>
          <p className="mt-1 text-xs text-muted">{t("rulesLead")}</p>
          <ul className="mt-3 divide-y divide-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="statement-rule">
                <span>
                  {t("ruleText", { pattern: rule.pattern, action: describe(rule.target) })} <span className="text-xs text-muted">{t("ruleUsed", { count: rule.timesUsed })}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void deleteRule(rule.id)}>
                  {t("ruleDelete")}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function LineHeader({ line, amount }: { line: Line; amount: string }) {
  const t = useTranslations("bank");
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{line.description || t("noDescription")}</p>
        <p className="text-xs text-muted">
          {line.date} · {line.accountLabel}
          {line.reference ? ` · ${line.reference}` : ""}
        </p>
      </div>
      <p className="text-base font-semibold text-success">+{amount}</p>
    </div>
  );
}

/** The "Other…" panel: say what this money is when Bizora has no good guess. */
function Classify({ line, currency, busy, onSave }: { line: Line; currency: string; busy: boolean; onSave: (target: ReconcileTarget, rulePattern?: string) => void }) {
  const t = useTranslations("bank");
  const locale = useLocale();
  const [choice, setChoice] = useState<Choice>("debtor");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [reason, setReason] = useState("");
  const [always, setAlways] = useState(false);
  const [pattern, setPattern] = useState(patternFrom(line.description));
  const needsCustomer = choice === "debtor" || choice === "advance";

  useEffect(() => {
    if (!needsCustomer || customers) return;
    void api("/api/v1/reconciliation/customers")
      .then(async (response) => {
        const items: Customer[] = response.ok ? (await response.json()).data.items : [];
        setCustomers(items);
        if (items[0]) setCustomerId(items[0].id);
      })
      .catch(() => setCustomers([]));
  }, [needsCustomer, customers]);

  function target(): ReconcileTarget | null {
    if (choice === "debtor" || choice === "advance") return customerId ? { kind: choice, customerId } : null;
    if (choice === "ignored") return reason.trim() ? { kind: "ignored", reason: reason.trim() } : null;
    const [kind, value] = choice.split(":");
    if (kind === "money_in") return { kind: "money_in", category: value as "unrecorded_sales" | "owner_capital" | "other_income" };
    return { kind: "own_transfer", source: value as "pos_settlement" | "cash_deposit" | "other_account" };
  }

  const ready = target();
  return (
    <div className="mt-3 space-y-3 rounded-card border border-border p-3">
      <FormField id={`classify-${line.id}`} label={t("whatIsIt")}>
        <Select id={`classify-${line.id}`} value={choice} onChange={(event) => setChoice(event.target.value as Choice)}>
          {CHOICES.map((option) => (
            <option key={option} value={option}>
              {t(`choice.${option.replace(":", "_")}`)}
            </option>
          ))}
        </Select>
      </FormField>
      {choice.startsWith("own_transfer") ? <p className="text-xs text-muted">{t("transferHint")}</p> : null}
      {needsCustomer ? (
        <FormField id={`classify-customer-${line.id}`} label={t("customer")}>
          <Select id={`classify-customer-${line.id}`} value={customerId} onChange={(event) => setCustomerId(event.target.value)} disabled={!customers?.length}>
            {(customers ?? []).map((customer) => (
              <option key={customer.id} value={customer.id}>
                {BigInt(customer.owingMinor) > 0n ? t("customerOwes", { name: customer.name, owing: formatCurrency(BigInt(customer.owingMinor), currency, locale) }) : customer.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
      {choice === "ignored" ? (
        <FormField id={`classify-reason-${line.id}`} label={t("reason")}>
          <Input id={`classify-reason-${line.id}`} value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      ) : null}
      {choice !== "ignored" ? (
        <div className="space-y-2">
          <Checkbox label={t("always")} checked={always} onCheckedChange={(checked) => setAlways(checked === true)} />
          {always ? (
            <FormField id={`classify-pattern-${line.id}`} label={t("pattern")} hint={t("patternHint")}>
              <Input id={`classify-pattern-${line.id}`} value={pattern} maxLength={60} onChange={(event) => setPattern(event.target.value)} />
            </FormField>
          ) : null}
        </div>
      ) : null}
      <Button size="sm" disabled={!ready || busy || (always && pattern.trim().length < 3)} onClick={() => ready && onSave(ready, always ? pattern.trim() : undefined)}>
        {t("save")}
      </Button>
    </div>
  );
}

export default function BankPage() {
  return (
    <RequireAccess anyOf={[Permission.BANK_RECONCILE]}>
      <BankInbox />
    </RequireAccess>
  );
}
