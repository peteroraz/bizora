"use client";

import { IDEMPOTENCY_HEADER, Permission, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { PhoneInput } from "../../../components/phone-input";
import { RequireAccess } from "../../../components/require-access";
import { NameInput, SentenceInput } from "../../../components/typing";
import { formatCurrency, formatDay } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess, usePlace } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import { problemOf } from "../../../lib/money-client";
import type { SupplierList } from "../../../lib/supplier-client";

/** Suppliers with what is owed to each, the biggest debts first, and adding one (ADR-029). */
function SuppliersScreen() {
  const t = useTranslations("suppliers");
  const locale = useLocale();
  const access = useAccess();
  const place = usePlace();
  const manages = can(access, Permission.PURCHASES_MANAGE);
  const [list, setList] = useState<SupplierList | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (search: string) => {
    const response = await api(`/api/v1/suppliers${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`).catch(() => null);
    if (response?.ok) setList((await response.json()).data as SupplierList);
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const id = uuidv7();
    try {
      const response = await api("/api/v1/suppliers", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({ id, name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      setNotice(t("added"));
      setAdding(false);
      setName("");
      setPhone("");
      setNotes("");
      await load(query);
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  const money = (minor: string) => (list ? formatCurrency(BigInt(minor), list.currency, locale) : "");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        intro={t("lead")}
        actions={
          manages && !adding ? (
            <Button type="button" onClick={() => setAdding(true)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />
      {list ? (
        <Card data-testid="suppliers-total">
          <p className="text-sm text-muted">{t("owed")}</p>
          <p className="text-2xl font-semibold tabular-nums">{money(list.owedMinor)}</p>
          <p className="text-sm text-muted">{t("owing", { count: list.owing })}</p>
          {list.overdueMinor !== "0" ? <p className="mt-1 text-sm font-medium text-danger">{t("overdue", { amount: money(list.overdueMinor) })}</p> : null}
        </Card>
      ) : null}
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {adding ? (
        <Card>
          <form className="space-y-4" onSubmit={(event) => void add(event)}>
            <FormField id="supplier-name" label={t("name")}>
              <NameInput id="supplier-name" value={name} maxLength={160} required onChange={(event) => setName(event.target.value)} />
            </FormField>
            <FormField id="supplier-phone" label={t("phone")} hint={t("phoneHint")}>
              <PhoneInput id="supplier-phone" country={place.country} value={phone} onChange={(event) => setPhone(event.target.value)} />
            </FormField>
            <FormField id="supplier-notes" label={t("notes")} hint={t("notesHint")}>
              <SentenceInput id="supplier-notes" value={notes} maxLength={240} onChange={(event) => setNotes(event.target.value)} />
            </FormField>
            {error ? (
              <p className="text-sm font-medium text-danger" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? t("saving") : t("save")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <form
        className="flex gap-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void load(query);
        }}
      >
        <Input aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button type="submit" variant="outline">
          {t("searchButton")}
        </Button>
      </form>
      {list && list.items.length === 0 ? <p className="text-sm text-muted">{query.trim() ? t("noneFound") : t("none")}</p> : null}
      <ul className="space-y-2" data-testid="supplier-list">
        {list?.items.map((supplier) => {
          const owed = BigInt(supplier.owedMinor);
          return (
            <li key={supplier.id}>
              <Link href={`/app/suppliers/${supplier.id}`} className="block rounded-card border border-border bg-surface p-4 hover:border-primary">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`font-medium ${supplier.unnamed ? "italic" : ""}`}>{supplier.name}</p>
                    {supplier.overdueMinor !== "0" ? (
                      <p className="text-sm font-medium text-danger">{t("overdue", { amount: money(supplier.overdueMinor) })}</p>
                    ) : supplier.nextPayBy ? (
                      <p className="text-sm text-muted">{t("payBy", { date: formatDay(supplier.nextPayBy, locale) })}</p>
                    ) : null}
                  </div>
                  <p className={`tabular-nums ${owed > 0n ? "font-semibold" : "text-sm text-muted"}`}>{owed > 0n ? money(supplier.owedMinor) : t("nothingOwed")}</p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function SuppliersPage() {
  return (
    <RequireAccess anyOf={[Permission.PURCHASES_MANAGE, Permission.MONEY_READ]}>
      <SuppliersScreen />
    </RequireAccess>
  );
}
