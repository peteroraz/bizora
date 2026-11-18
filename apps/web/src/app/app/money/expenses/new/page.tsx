"use client";

import { EXPENSE_PAID_FROM, IDEMPOTENCY_HEADER, Permission, parseAmount, uuidv7, type ExpensePaidFrom } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, Select } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../../components/action-link";
import { RequireAccess } from "../../../../../components/require-access";
import { AmountInput, NameInput, SentenceInput } from "../../../../../components/typing";
import { dayKey } from "../../../../../i18n/format";
import { can } from "../../../../../lib/access";
import { useAccess, usePlace } from "../../../../../lib/access-context";
import { api } from "../../../../../lib/api";
import { problemOf } from "../../../../../lib/money-client";

/** Recording money paid out for running the business, for the shop chosen in the header (ADR-028). */
function NewExpenseScreen() {
  const t = useTranslations("money");
  const router = useRouter();
  const access = useAccess();
  const place = usePlace();
  const approves = can(access, Permission.EXPENSES_APPROVE);
  const today = dayKey(new Date(), place.timezone);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>("cash");
  const [day, setDay] = useState(today);
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // One ID per expense being written, so tapping Save twice records it once.
  const [id] = useState(() => uuidv7());

  useEffect(() => {
    void api("/api/v1/money/categories")
      .then(async (response) => (response.ok ? setCategories((await response.json()).data.categories) : undefined))
      .catch(() => undefined);
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const minor = parseAmount(amount, place.currency);
    if (!categoryId) return setError(t("expense.category"));
    if (minor === null || minor <= 0n) return setError(t("invalidAmount"));
    setPending(true);
    try {
      const response = await api("/api/v1/money/expenses", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({
          id,
          categoryId,
          amountMinor: minor.toString(),
          paidFrom,
          expenseDate: day,
          ...(payee.trim() ? { payee: payee.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      const expense = (await response.json()).data.expense as { status: string };
      router.push(`/app/money/expenses?saved=${expense.status === "approved" ? "approved" : "waiting"}`);
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <BackLink href="/app/money">{t("back")}</BackLink>
      <PageHeader title={t("expense.newTitle")} intro={t("expense.newLead")} />
      <Card>
        <form className="space-y-4" onSubmit={(event) => void save(event)} data-testid="expense-form">
          <FormField id="expense-category" label={t("expense.category")}>
            <Select id="expense-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>
              <option value="">{t("expense.choose")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id="expense-amount" label={t("amount")}>
            <AmountInput currency={place.currency} id="expense-amount" value={amount} onChange={(event) => setAmount(event.target.value)} required />
          </FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("expense.paidFrom")}</legend>
            {EXPENSE_PAID_FROM.map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-3 rounded-control border border-border px-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="paidFrom" value={option} checked={paidFrom === option} onChange={() => setPaidFrom(option)} />
                {t(`expense.paidFrom_${option}`)}
              </label>
            ))}
          </fieldset>
          <FormField id="expense-day" label={t("date")}>
            <Input id="expense-day" type="date" max={today} value={day} onChange={(event) => setDay(event.target.value || today)} required />
          </FormField>
          <FormField id="expense-payee" label={t("expense.payee")} hint={t("expense.payeeHint")}>
            <NameInput id="expense-payee" value={payee} maxLength={120} onChange={(event) => setPayee(event.target.value)} />
          </FormField>
          <FormField id="expense-note" label={t("note")} hint={t("noteHint")}>
            <SentenceInput id="expense-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          {!approves ? <p className="text-sm text-muted">{t("expense.needsApproval")}</p> : null}
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

export default function NewExpensePage() {
  return (
    <RequireAccess anyOf={[Permission.EXPENSES_RECORD]}>
      <NewExpenseScreen />
    </RequireAccess>
  );
}
