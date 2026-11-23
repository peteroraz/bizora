"use client";

import { Permission } from "@bizora/contracts";
import { Button, FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useState } from "react";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
// Imported directly (not loaded on demand) so it is already on the phone when the network drops (ADR-044).
import { readCustomerDirectory } from "../lib/offline/customers";

// The add-customer form (name and phone boxes, the country's phone rules) loads when it is opened (JS budget).
const CustomerQuickAdd = lazy(() => import("./customer-quick-add"));

export type PickedCustomer = { id: string; name: string; credit?: { allowed: boolean; limitMinor: string | null } };

/** Find a customer by phone number or name (works with the full list and with the cashier's counter lookup). */
export function CustomerPicker({ id, value, onChange }: { id: string; value: PickedCustomer | null; onChange: (customer: PickedCustomer | null) => void }) {
  const t = useTranslations("sales");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const access = useAccess();
  // Anyone recording sales may add a new or walk-in customer on the spot (ADR-019).
  const canAdd = can(access, Permission.CUSTOMERS_MANAGE, Permission.CUSTOMERS_ADD);
  const [adding, setAdding] = useState(false);
  const [start, setStart] = useState({ name: "", phone: "" });

  async function find() {
    setMessage(null);
    if (!query.trim()) return;
    const response = await api(`/api/v1/customers?q=${encodeURIComponent(query.trim())}`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    // No network: search the customer names saved on this phone (ADR-044), so a sale on credit can still be recorded.
    if (!response && access.owner) {
      const saved = await readCustomerDirectory(access.owner).catch(() => null);
      const asked = query.trim().toLowerCase();
      const items = (saved?.items ?? [])
        .filter((item) => item.name.toLowerCase().includes(asked))
        .slice(0, 6)
        .map((item) => ({ id: item.id, name: item.name, credit: { allowed: item.creditAllowed, limitMinor: null } }));
      setResults(items);
      setMessage(saved ? (items.length === 0 ? t("noCustomerOffline") : t("customerOffline")) : t("customerSearchFailed"));
      return;
    }
    if (!response?.ok) {
      setResults([]);
      setMessage(payload?.error?.message ?? t("customerSearchFailed"));
      return;
    }
    const items = (payload.data.items as PickedCustomer[]).slice(0, 6);
    setResults(items);
    if (items.length === 0) setMessage(t("noCustomer"));
  }

  if (value) {
    return (
      <p className="flex items-center justify-between gap-3 text-sm">
        <span>
          <span className="font-medium">{value.name}</span>
          <span className="block text-xs text-muted">{value.credit?.allowed ? t("creditApproved") : t("creditNotApproved")}</span>
        </span>
        <button type="button" className="text-primary" onClick={() => onChange(null)}>
          {t("change")}
        </button>
      </p>
    );
  }
  return (
    <div>
      <div className="flex items-end gap-2">
        <FormField id={id} label={t("customerSearch")}>
          <Input
            id={id}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void find();
              }
            }}
          />
        </FormField>
        <Button type="button" variant="secondary" onClick={() => void find()}>
          {t("find")}
        </Button>
      </div>
      {message ? <p className="mt-2 text-sm text-muted">{message}</p> : null}
      {canAdd && !adding ? (
        <button
          type="button"
          className="mt-1 min-h-11 text-sm font-medium text-primary"
          onClick={() => {
            setAdding(true);
            // What was searched for starts the new customer: a name, or a phone number.
            const typed = query.trim();
            setStart(/^[+\d\s-]+$/.test(typed) ? { name: "", phone: typed } : { name: typed, phone: "" });
          }}
        >
          {t("addNewCustomer")}
        </button>
      ) : null}
      {canAdd && adding ? (
        <Suspense fallback={null}>
          <CustomerQuickAdd
            id={id}
            initialName={start.name}
            initialPhone={start.phone}
            onAdded={(customer) => {
              setAdding(false);
              onChange(customer);
            }}
            onAlreadyCustomer={(phone) => {
              setAdding(false);
              setQuery(phone);
              setMessage(t("alreadyCustomer"));
              void api(`/api/v1/customers?q=${encodeURIComponent(phone)}`)
                .then(async (found) => (found.ok ? setResults(((await found.json()).data.items as PickedCustomer[]).slice(0, 6)) : undefined))
                .catch(() => undefined);
            }}
            onCancel={() => setAdding(false)}
          />
        </Suspense>
      ) : null}
      <ul className="mt-2 space-y-1 text-sm">
        {results.map((item) => (
          <li key={item.id}>
            <button type="button" className="text-primary" onClick={() => onChange(item)}>
              {item.name}
            </button>
            {item.credit?.allowed ? <span className="ml-2 text-xs text-muted">{t("creditApproved")}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
