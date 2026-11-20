"use client";

import { currencyDigits, IDEMPOTENCY_HEADER, parseAmount, Permission, uuidv7, type CaptureResult } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, Select } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { CaptureBar } from "../../../../components/capture-bar";
import { CustomerPicker, type PickedCustomer } from "../../../../components/customer-picker";
import { JobLinesEditor, RegularsList } from "../../../../components/job-lines-editor";
import { RequireAccess } from "../../../../components/require-access";
import { AmountInput, NameInput, SentenceInput } from "../../../../components/typing";
import { formatCurrency } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { draftFromCapture, linesToPayload, type DraftLine, type Regular } from "../../../../lib/jobs-client";
import { draftTotal } from "../../../../lib/jobs-totals";
import { problemOf } from "../../../../lib/money-client";

const today = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

/**
 * A new job (ADR-035). Say it ("Mr Okeke brought his Camry, we changed the brake pads for 15,000, bought 4 litres of
 * oil for 12,000, he paid 10,000") or type it. The AI's summary comes first, then every line to check, change or
 * take off; more lines can be added by hand. Nothing is saved until Save.
 */
function NewJobScreen() {
  const t = useTranslations("jobs");
  const locale = useLocale();
  const router = useRouter();
  const access = useAccess();
  const place = usePlace();
  const digits = currencyDigits(place.currency);
  const takesMoney = can(access, Permission.PAYMENTS_RECORD, Permission.SALES_COLLECT);
  const [id] = useState(() => uuidv7());
  const [regulars, setRegulars] = useState<Regular[]>([]);
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [day, setDay] = useState(() => today(place.timezone));
  const [promisedOn, setPromisedOn] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer" | "pos">("cash");
  const [finish, setFinish] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [summary, setSummary] = useState("");
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api("/api/v1/jobs/regulars")
      .then(async (response) => (response.ok ? setRegulars((await response.json()).data.items as Regular[]) : undefined))
      .catch(() => undefined);
    const customerId = new URLSearchParams(window.location.search).get("customerId");
    const customerName = new URLSearchParams(window.location.search).get("customerName");
    if (customerId && customerName) setPicked({ id: customerId, name: customerName });
  }, []);

  async function heardJob(result: CaptureResult) {
    const draft = await draftFromCapture(result, place.currency, digits, regulars);
    if (!picked) {
      if (draft.customer) setName(draft.customer);
      if (draft.phone) setPhone(draft.phone);
    }
    if (draft.title) setTitle(draft.title);
    if (draft.problem) setProblem(draft.problem);
    if (draft.day) setDay(draft.day);
    if (draft.promisedOn) setPromisedOn(draft.promisedOn);
    if (draft.lines.length) setLines((current) => [...current, ...draft.lines]);
    if (draft.paid && takesMoney) {
      setPaid(draft.paid);
      setMethod(draft.method);
    }
    setFinish(draft.finished);
    setSummary(draft.summary);
    setHeard(result.transcript);
  }

  const total = useMemo(() => draftTotal(lines, place.currency), [lines, place.currency]);
  const paidMinor = paid.trim() ? (parseAmount(paid, place.currency) ?? 0n) : 0n;
  const left = total - paidMinor;

  async function save() {
    setError(null);
    if (!picked && !name.trim()) return setError(t("problems.customer"));
    const built = linesToPayload(lines, place.currency);
    if ("problem" in built) return setError(t(`problems.${built.problem}`, { line: built.line }));
    if (finish && lines.length === 0) return setError(t("problems.noLines"));
    const payment = paid.trim() ? parseAmount(paid, place.currency) : null;
    if (paid.trim() && (payment === null || payment <= 0n)) return setError(t("problems.paid"));
    setPending(true);
    try {
      const response = await api("/api/v1/jobs", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({
          id,
          ...(picked ? { customerId: picked.id } : { customer: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) } }),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(problem.trim() ? { problem: problem.trim() } : {}),
          ...(summary.trim() ? { summary: summary.trim().slice(0, 600) } : {}),
          day,
          ...(promisedOn ? { promisedOn } : {}),
          lines: built.lines,
          ...(payment ? { payment: { method, amountMinor: payment.toString() } } : {}),
          ...(finish ? { finish: true, ...(dueDate ? { dueDate } : {}) } : {}),
        }),
      });
      if (!response.ok) return setError(await problemOf(response, t("failed")));
      router.push(`/app/jobs/${id}?saved=1`);
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <BackLink href="/app/jobs">{t("back")}</BackLink>
      <PageHeader title={t("newTitle")} intro={t("newLead")} />
      <CaptureBar target="job" onRows={(result) => void heardJob(result)} />
      {summary ? (
        <Card className="space-y-1" data-testid="job-summary">
          <p className="text-sm font-medium">{t("understood")}</p>
          <p className="text-sm">{summary}</p>
          {heard ? <p className="text-xs text-muted">{t("heard", { words: heard })}</p> : null}
        </Card>
      ) : null}

      <Card className="space-y-3">
        <p className="text-sm font-medium">{t("customerTitle")}</p>
        {picked ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{picked.name}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(null)}>
              {t("changeCustomer")}
            </Button>
          </div>
        ) : (
          <>
            <CustomerPicker id="job-customer" value={picked} onChange={setPicked} />
            <p className="text-xs text-muted">{t("orNew")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="job-customer-name" label={t("customerName")}>
                <NameInput id="job-customer-name" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} />
              </FormField>
              <FormField id="job-customer-phone" label={t("customerPhone")} hint={t("optional")}>
                <Input id="job-customer-phone" type="tel" inputMode="tel" value={phone} maxLength={32} onChange={(event) => setPhone(event.target.value)} />
              </FormField>
            </div>
          </>
        )}
      </Card>

      <Card className="space-y-3">
        <FormField id="job-title" label={t("title")} hint={t("titleHint")}>
          <SentenceInput id="job-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField id="job-problem" label={t("problem")} hint={t("optional")}>
          <SentenceInput id="job-problem" value={problem} maxLength={1000} onChange={(event) => setProblem(event.target.value)} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="job-day" label={t("day")}>
            <Input id="job-day" type="date" value={day} max={today(place.timezone)} onChange={(event) => setDay(event.target.value)} />
          </FormField>
          <FormField id="job-promised" label={t("promised")} hint={t("optional")}>
            <Input id="job-promised" type="date" value={promisedOn} onChange={(event) => setPromisedOn(event.target.value)} />
          </FormField>
        </div>
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-medium">{t("linesTitle")}</p>
        <RegularsList regulars={regulars} />
        <JobLinesEditor lines={lines} onChange={setLines} regulars={regulars} />
      </Card>

      <Card className="space-y-3">
        <p className="flex justify-between text-sm font-medium" data-testid="job-total">
          <span>{t("total")}</span>
          <span>{formatCurrency(total, place.currency, locale)}</span>
        </p>
        {takesMoney ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="job-paid" label={finish ? t("paidNow") : t("deposit")} hint={t("optional")}>
              <AmountInput currency={place.currency} id="job-paid" value={paid} onChange={(event) => setPaid(event.target.value)} />
            </FormField>
            <FormField id="job-method" label={t("method")}>
              <Select id="job-method" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                {(["cash", "transfer", "pos"] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`methods.${option}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        ) : (
          <p className="text-sm text-muted">{t("cashierTakesMoney")}</p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={finish} onChange={(event) => setFinish(event.target.checked)} />
          {t("finishedNow")}
        </label>
        {finish && left > 0n ? (
          <FormField id="job-due" label={t("dueDate")} hint={t("dueHint", { amount: formatCurrency(left, place.currency, locale) })}>
            <Input id="job-due" type="date" value={dueDate} min={today(place.timezone)} onChange={(event) => setDueDate(event.target.value)} />
          </FormField>
        ) : null}
        {!finish && total > 0n ? <p className="text-sm text-muted">{t("leftOpen", { amount: formatCurrency(left > 0n ? left : 0n, place.currency, locale) })}</p> : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="button" disabled={pending} onClick={() => void save()}>
          {pending ? t("saving") : finish ? t("saveFinish") : t("saveOpen")}
        </Button>
      </Card>
    </div>
  );
}

export default function NewJobPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE]}>
      <NewJobScreen />
    </RequireAccess>
  );
}
