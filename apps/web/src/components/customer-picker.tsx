"use client";

import { IDEMPOTENCY_HEADER, Permission, uuidv7 } from "@bizora/contracts";
import { Button, FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
import { enqueue } from "../lib/offline/outbox";
import { isNetworkFailure } from "../lib/offline/sync";

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
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    setMessage(null);
    if (!newName.trim()) {
      setMessage(t("newCustomerName"));
      return;
    }
    const id = uuidv7();
    const body = { id, name: newName.trim(), ...(newPhone.trim() ? { phone: newPhone.trim() } : { isWalkIn: true }) };
    setSaving(true);
    try {
      const response = await api("/api/v1/customers", { method: "POST", headers: { [IDEMPOTENCY_HEADER]: id }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        const customer = payload.data.customer;
        onChange({ id: customer.id, name: customer.name, credit: customer.credit });
        setAdding(false);
        setNewName("");
        setNewPhone("");
        return;
      }
      if (payload?.error?.code === "DUPLICATE_PHONE") {
        // Already a customer: show them so they can be picked.
        setQuery(newPhone.trim());
        setAdding(false);
        setMessage(t("alreadyCustomer"));
        const found = await api(`/api/v1/customers?q=${encodeURIComponent(newPhone.trim())}`).catch(() => null);
        if (found?.ok) setResults(((await found.json()).data.items as PickedCustomer[]).slice(0, 6));
        return;
      }
      setMessage(payload?.error?.message ?? t("newCustomerFailed"));
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
        // No network: the customer is saved on the phone and sent before the sale that uses them.
        await enqueue(access.owner, "customer.create", body);
        onChange({ id, name: body.name, credit: { allowed: false, limitMinor: null } });
        setAdding(false);
        setNewName("");
        setNewPhone("");
      } else {
        setMessage(t("newCustomerFailed"));
      }
    } finally {
      setSaving(false);
    }
  }

  async function find() {
    setMessage(null);
    if (!query.trim()) return;
    const response = await api(`/api/v1/customers?q=${encodeURIComponent(query.trim())}`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
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
          className="mt-2 text-sm font-medium text-primary"
          onClick={() => {
            setAdding(true);
            if (query.trim() && !/^[+\d\s-]+$/.test(query.trim())) setNewName(query.trim());
            else if (query.trim()) setNewPhone(query.trim());
          }}
        >
          {t("addNewCustomer")}
        </button>
      ) : null}
      {canAdd && adding ? (
        <div className="mt-3 space-y-2 rounded-card border border-border p-3">
          <p className="text-sm font-medium">{t("newCustomerTitle")}</p>
          <FormField id={`${id}-new-name`} label={t("newCustomerNameLabel")}>
            <Input id={`${id}-new-name`} value={newName} maxLength={160} onChange={(event) => setNewName(event.target.value)} />
          </FormField>
          <FormField id={`${id}-new-phone`} label={t("newCustomerPhoneLabel")} hint={t("newCustomerPhoneHint")}>
            <Input id={`${id}-new-phone`} type="tel" inputMode="tel" value={newPhone} maxLength={32} onChange={(event) => setNewPhone(event.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" disabled={saving} onClick={() => void add()}>
              {saving ? t("saving") : t("newCustomerSave")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              {t("newCustomerCancel")}
            </Button>
          </div>
        </div>
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
