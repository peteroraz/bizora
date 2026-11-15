"use client";

import { CUSTOMER_PAGE_SIZE, Permission } from "@bizora/contracts";
import { EmptyState, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { can } from "../../../lib/access";
import { useAccess } from "../../../lib/access-context";
import { api } from "../../../lib/api";

type Customer = { id: string; name: string; phoneE164: string | null; isWalkIn: boolean; email: string | null };

export default function CustomersPage() {
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
