"use client";

import { CUSTOMER_PAGE_SIZE, LOOKUP_MIN_QUERY, LOOKUP_RESULT_LIMIT, Permission } from "@bizora/contracts";
import { EmptyState, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RequireAccess } from "../../../components/require-access";
import { can, customerMode } from "../../../lib/access";
import { useAccess } from "../../../lib/access-context";
import { api } from "../../../lib/api";

type Customer = { id: string; name: string; phoneE164: string | null; isWalkIn: boolean; email: string | null };
type LookupResult = { id: string; name: string; isWalkIn: boolean; phoneLast4: string | null };

function CustomerListScreen() {
  const t = useTranslations("customers");
  const canManage = can(useAccess(), Permission.CUSTOMERS_MANAGE);
  const common = useTranslations("common");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  async function load(nextQuery: string, nextPage: number) {
    setPending(true);
    const params = new URLSearchParams({ page: String(nextPage) });
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    const response = await api(`/api/v1/customers?${params.toString()}`);
    const payload = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) return;
    setItems(payload.data?.items ?? []);
    setTotal(payload.data?.total ?? 0);
    setPage(payload.data?.page ?? nextPage);
    setLoaded(true);
  }

  useEffect(() => {
    void load("", 1);
  }, []);

  const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canManage ? (
            <div className="flex gap-3 text-sm font-medium">
              <Link href="/app/customers/import" className="text-primary">
                {t("import")}
              </Link>
              <Link href="/app/customers/new" className="text-primary">
                {t("add")}
              </Link>
            </div>
          ) : undefined
        }
      />
      <SafeForm
        className="flex flex-wrap items-end gap-3"
        pending={pending}
        onSubmit={() => {
          void load(query, 1);
        }}
      >
        <FormField id="customer-search" label={t("searchLabel")}>
          <Input
            id="customer-search"
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </FormField>
        <SubmitButton pending={pending} pendingLabel={common("loading")}>
          {t("search")}
        </SubmitButton>
      </SafeForm>
      {loaded && items.length === 0 ? (
        <EmptyState title={query.trim() ? t("noResults") : t("emptyTitle")} description={query.trim() ? t("description") : t("emptyBody")} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((customer) => (
            <li key={customer.id}>
              <Link href={`/app/customers/${customer.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span className="block text-sm font-medium">{customer.name}</span>
                  <span className="block text-sm text-muted">{customer.isWalkIn ? t("walkIn") : customer.phoneE164}</span>
                </span>
                {customer.email ? <span className="text-sm text-muted">{customer.email}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > CUSTOMER_PAGE_SIZE ? (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="font-medium text-primary" disabled={page <= 1} onClick={() => void load(query, page - 1)}>
            {t("previous")}
          </button>
          <span>{t("page", { page })}</span>
          <button type="button" className="font-medium text-primary" disabled={page >= pages} onClick={() => void load(query, page + 1)}>
            {t("next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Cashier: find one customer at the counter. No list to browse, and only the name and the end of the phone number. */
function CustomerLookupScreen() {
  const t = useTranslations("customers");
  const common = useTranslations("common");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LookupResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function search() {
    const needle = query.trim();
    const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
    if (needle.length < LOOKUP_MIN_QUERY || (/^[\d\s+()-]+$/.test(needle) && digits.length < 7)) {
      setError(t("lookupTooShort", { min: LOOKUP_MIN_QUERY }));
      return;
    }
    setError(null);
    setPending(true);
    const response = await api(`/api/v1/customers?${new URLSearchParams({ q: needle }).toString()}`);
    const payload = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? t("lookupFailed"));
      return;
    }
    setItems(payload?.data?.items ?? []);
    setSearched(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("lookupTitle")} description={t("lookupLead")} />
      <SafeForm
        className="flex flex-wrap items-end gap-3"
        pending={pending}
        onSubmit={() => {
          void search();
        }}
      >
        <FormField id="customer-lookup" label={t("searchLabel")}>
          <Input id="customer-lookup" value={query} placeholder={t("searchPlaceholder")} onChange={(event) => setQuery(event.target.value)} />
        </FormField>
        <SubmitButton pending={pending} pendingLabel={common("loading")}>
          {t("search")}
        </SubmitButton>
      </SafeForm>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {searched && items.length === 0 ? <p className="text-sm text-muted">{t("noResults")}</p> : null}
      {items.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card">
          {items.map((customer) => (
            <li key={customer.id}>
              <Link href={`/app/customers/${customer.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-medium">{customer.name}</span>
                <span className="text-sm text-muted">
                  {customer.isWalkIn || !customer.phoneLast4 ? t("walkIn") : t("phoneEnds", { digits: customer.phoneLast4 })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length >= LOOKUP_RESULT_LIMIT ? <p className="text-sm text-muted">{t("lookupMore", { count: LOOKUP_RESULT_LIMIT })}</p> : null}
      <p className="text-xs text-muted">{t("limitedNote")}</p>
    </div>
  );
}

export default function CustomersPage() {
  const mode = customerMode(useAccess());
  if (mode === "list") return <CustomerListScreen />;
  if (mode === "lookup") return <CustomerLookupScreen />;
  return (
    <RequireAccess anyOf={[Permission.CUSTOMERS_READ, Permission.CUSTOMERS_LOOKUP]}>
      <CustomerListScreen />
    </RequireAccess>
  );
}
