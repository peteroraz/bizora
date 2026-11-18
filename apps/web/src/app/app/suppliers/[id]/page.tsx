"use client";

import { IDEMPOTENCY_HEADER, Permission, SUPPLIER_PAID_FROM, amountText, parseAmount, quantityToString, uuidv7, whatsAppHref, type SupplierPaidFrom } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader } from "@bizora/ui";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { PhoneInput } from "../../../../components/phone-input";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { AmountInput, NameInput, SentenceInput } from "../../../../components/typing";
import { dayKey, formatCurrency, formatDay, formatPhone } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";
import type { SupplierDetail, SupplierEntry } from "../../../../lib/supplier-client";

/** One supplier: what is owed and when, paying them, what was owed before Bizora, and every delivery and payment. */
function SupplierScreen() {
  const t = useTranslations("suppliers");
  const locale = useLocale();
  const unitName = useUnitName();
  const { id } = useParams<{ id: string }>();
  const access = useAccess();
  const place = usePlace();
  const manages = can(access, Permission.PURCHASES_MANAGE);
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<"pay" | "opening" | "edit" | null>(null);
  const [amount, setAmount] = useState("");
  const [paidFrom, setPaidFrom] = useState<SupplierPaidFrom>("cash");
  const [note, setNote] = useState("");
  const [payBy, setPayBy] = useState("");
  const [edit, setEdit] = useState({ name: "", phone: "", notes: "" });
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => uuidv7());

  const load = useCallback(async () => {
    const response = await api(`/api/v1/suppliers/${id}`).catch(() => null);
    if (response?.ok) setDetail((await response.json()).data as SupplierDetail);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(path: string, body: unknown, done: string, method = "POST") {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await api(path, { method, headers: method === "POST" ? { [IDEMPOTENCY_HEADER]: key } : {}, body: JSON.stringify(body) });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return false;
      }
      const data = (await response.json()).data as SupplierDetail;
      setDetail(data);
      setNotice(done);
      setPanel(null);
      setAmount("");
      setNote("");
      setPayBy("");
      setKey(uuidv7());
      return true;
    } catch {
      setError(t("failed"));
      return false;
    } finally {
      setPending(false);
    }
  }

  function minor(text: string) {
    const value = parseAmount(text, detail?.currency ?? place.currency);
    return value !== null && value > 0n ? value.toString() : null;
  }

  async function cancel(entry: SupplierEntry) {
    if (await send(`/api/v1/suppliers/entries/${entry.id}/void`, { reason }, t("cancelled"))) {
      setCancelling(null);
      setReason("");
    }
  }

  if (!detail) return null;
  const { supplier } = detail;
  const money = (value: string | bigint) => formatCurrency(BigInt(value), detail.currency, locale);
  const owed = BigInt(detail.owedMinor);
  const today = dayKey(new Date(), place.timezone);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink href="/app/suppliers">{t("back")}</BackLink>
      <PageHeader title={supplier.name} intro={supplier.unnamed ? t("unnamedHint") : (supplier.notes ?? undefined)} />
      {supplier.phoneE164 ? (
        <div className="flex flex-wrap gap-3 text-sm font-medium">
          <a className="text-primary" href={`tel:${supplier.phoneE164}`}>
            {t("call")} {formatPhone(supplier.phoneE164)}
          </a>
          <a className="text-primary" href={whatsAppHref(supplier.phoneE164, "")} target="_blank" rel="noreferrer">
            {t("whatsapp")}
          </a>
        </div>
      ) : null}
      <Card data-testid="supplier-owed">
        <p className="text-sm text-muted">{t("owed")}</p>
        <p className="text-3xl font-semibold tabular-nums">{owed > 0n ? money(owed) : t("nothingOwed")}</p>
        {detail.overdueMinor !== "0" ? (
          <p className="text-sm font-medium text-danger">{t("overdue", { amount: money(detail.overdueMinor) })}</p>
        ) : detail.nextPayBy ? (
          <p className="text-sm text-muted">{t("payBy", { date: formatDay(detail.nextPayBy, locale) })}</p>
        ) : null}
        {manages ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {owed > 0n ? (
              <Button type="button" onClick={() => setPanel(panel === "pay" ? null : "pay")}>
                {t("pay")}
              </Button>
            ) : null}
            {!supplier.unnamed ? (
              <Button type="button" variant="outline" onClick={() => setPanel(panel === "opening" ? null : "opening")}>
                {t("opening")}
              </Button>
            ) : null}
            {!supplier.unnamed ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEdit({ name: supplier.name, phone: supplier.phoneE164 ?? "", notes: supplier.notes ?? "" });
                  setPanel(panel === "edit" ? null : "edit");
                }}
              >
                {t("edit")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {panel === "pay" ? (
        <Card>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const value = minor(amount);
              if (!value) return setError(t("payAmount"));
              void send(`/api/v1/suppliers/${supplier.id}/payments`, { id: key, amountMinor: value, paidFrom, ...(note.trim() ? { note: note.trim() } : {}) }, t("paid"));
            }}
          >
            <FormField id="pay-amount" label={t("payAmount")}>
              <AmountInput currency={detail.currency} id="pay-amount" value={amount} required onChange={(event) => setAmount(event.target.value)} />
            </FormField>
            <button type="button" className="text-sm font-medium text-primary" onClick={() => setAmount(amountText(owed, detail.currency))}>
              {t("payAll", { amount: money(owed) })}
            </button>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("paidFrom")}</legend>
              {SUPPLIER_PAID_FROM.map((option) => (
                <label key={option} className="flex min-h-11 items-center gap-3 rounded-control border border-border px-3 text-sm has-[:checked]:border-primary">
                  <input type="radio" name="paidFrom" value={option} checked={paidFrom === option} onChange={() => setPaidFrom(option)} />
                  {t(`paidFrom_${option}`)}
                </label>
              ))}
            </fieldset>
            <FormField id="pay-note" label={t("payNote")}>
              <SentenceInput id="pay-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
            </FormField>
            <Button type="submit" disabled={pending}>
              {pending ? t("saving") : t("paySave")}
            </Button>
          </form>
        </Card>
      ) : null}

      {panel === "opening" ? (
        <Card>
          <p className="mb-3 text-sm text-muted">{t("openingLead")}</p>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const value = minor(amount);
              if (!value) return setError(t("openingAmount"));
              void send(
                `/api/v1/suppliers/${supplier.id}/opening`,
                { id: key, amountMinor: value, ...(payBy ? { payBy } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
                t("openingAdded"),
              );
            }}
          >
            <FormField id="opening-amount" label={t("openingAmount")}>
              <AmountInput currency={detail.currency} id="opening-amount" value={amount} required onChange={(event) => setAmount(event.target.value)} />
            </FormField>
            <FormField id="opening-pay-by" label={t("openingPayBy")}>
              <Input id="opening-pay-by" type="date" min={today} value={payBy} onChange={(event) => setPayBy(event.target.value)} />
            </FormField>
            <Button type="submit" disabled={pending}>
              {pending ? t("saving") : t("openingSave")}
            </Button>
          </form>
        </Card>
      ) : null}

      {panel === "edit" ? (
        <Card>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send(
                `/api/v1/suppliers/${supplier.id}`,
                { name: edit.name.trim(), phone: edit.phone.trim() || null, notes: edit.notes.trim() || null },
                t("updated"),
                "PATCH",
              );
            }}
          >
            <FormField id="edit-name" label={t("name")}>
              <NameInput id="edit-name" value={edit.name} maxLength={160} required onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
            </FormField>
            <FormField id="edit-phone" label={t("phone")} hint={t("phoneHint")}>
              <PhoneInput id="edit-phone" country={place.country} value={edit.phone} onChange={(event) => setEdit({ ...edit, phone: event.target.value })} />
            </FormField>
            <FormField id="edit-notes" label={t("notes")} hint={t("notesHint")}>
              <SentenceInput id="edit-notes" value={edit.notes} maxLength={240} onChange={(event) => setEdit({ ...edit, notes: event.target.value })} />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {t("saveChanges")}
              </Button>
              {owed === 0n ? (
                <Button type="button" variant="ghost" onClick={() => void send(`/api/v1/suppliers/${supplier.id}`, { archived: true }, t("archived"), "PATCH")}>
                  {t("archive")}
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("history")}</h2>
        {detail.entries.length === 0 ? <p className="text-sm text-muted">{t("noHistory")}</p> : null}
        <ul className="space-y-2" data-testid="supplier-history">
          {detail.entries.map((entry) => (
            <li key={entry.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{t(`kind_${entry.kind}`)}</p>
                    <p className="text-muted">
                      {formatDay(entry.entryDate, locale)}
                      {entry.shop ? ` · ${entry.shop}` : ""}
                      {entry.paidFrom ? ` · ${t(`paidFrom_${entry.paidFrom}`)}` : ""}
                    </p>
                    {entry.product && entry.quantity && entry.unit ? (
                      <p>
                        {t("deliveryLine", {
                          product: entry.product,
                          quantity: quantityToString(BigInt(entry.quantity)),
                          unit: unitName(entry.unit, Number(quantityToString(BigInt(entry.quantity)))),
                        })}
                      </p>
                    ) : null}
                    {entry.note ? <p>{entry.note}</p> : null}
                    {entry.payBy && entry.status === "recorded" ? (
                      <p className={entry.payBy < detail.today ? "text-danger" : "text-muted"}>{t("payBy", { date: formatDay(entry.payBy, locale) })}</p>
                    ) : null}
                    {entry.voidReason ? <p className="text-danger">{t("voided", { reason: entry.voidReason })}</p> : null}
                  </div>
                  <p className={`whitespace-nowrap tabular-nums ${entry.status === "voided" ? "text-muted line-through" : entry.kind === "payment" ? "text-success" : "font-semibold"}`}>
                    {entry.kind === "payment" ? "−" : "+"}
                    {money(entry.amountMinor)}
                  </p>
                </div>
                {entry.canCancel ? (
                  cancelling === entry.id ? (
                    <div className="mt-3 space-y-2">
                      <SentenceInput aria-label={t("cancelReason")} placeholder={t("cancelReason")} value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} />
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant="danger" disabled={reason.trim().length < 3 || pending} onClick={() => void cancel(entry)}>
                          {t("cancel")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setCancelling(null)}>
                          {t("keep")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="mt-2 text-xs text-primary" onClick={() => setCancelling(entry.id)}>
                      {t("cancel")}
                    </button>
                  )
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {detail.paidDeliveries.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">{t("paidDeliveries")}</h2>
          <ul className="divide-y divide-border rounded-card border border-border bg-surface text-sm">
            {detail.paidDeliveries.map((delivery) => (
              <li key={delivery.id} className="flex justify-between gap-3 px-4 py-3">
                <span>
                  {formatDay(delivery.occurredAt.slice(0, 10), locale)} ·{" "}
                  {t("deliveryLine", {
                    product: delivery.product,
                    quantity: quantityToString(BigInt(delivery.quantity)),
                    unit: unitName(delivery.unit, Number(quantityToString(BigInt(delivery.quantity)))),
                  })}
                </span>
                <span className="tabular-nums">{money(delivery.valueMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function SupplierPage() {
  return (
    <RequireAccess anyOf={[Permission.PURCHASES_MANAGE, Permission.MONEY_READ]}>
      <SupplierScreen />
    </RequireAccess>
  );
}
