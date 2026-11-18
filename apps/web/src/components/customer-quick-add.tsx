"use client";

import { IDEMPOTENCY_HEADER, uuidv7 } from "@bizora/contracts";
import { Button, FormField } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAccess, usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import { enqueue } from "../lib/offline/outbox";
import { isNetworkFailure } from "../lib/offline/sync";
import type { PickedCustomer } from "./customer-picker";
import { checkTypedPhone, PhoneInput } from "./phone-input";
import { NameInput } from "./typing";

/**
 * Adding a new or walk-in customer in the middle of a sale (ADR-019). Loaded only when "Add new customer" is
 * tapped, so the name and phone boxes and the country's phone rules stay out of the sale screen's first load.
 */
export default function CustomerQuickAdd({
  id,
  initialName,
  initialPhone,
  onAdded,
  onAlreadyCustomer,
  onCancel,
}: {
  id: string;
  initialName: string;
  initialPhone: string;
  onAdded: (customer: PickedCustomer) => void;
  onAlreadyCustomer: (phone: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("sales");
  const access = useAccess();
  const place = usePlace();
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function add() {
    setMessage(null);
    if (!name.trim()) {
      setMessage(t("newCustomerName"));
      return;
    }
    const checked = phone.trim() ? await checkTypedPhone(phone, place.country) : null;
    if (phone.trim() && !checked?.ok) {
      setMessage(t("newCustomerPhoneCheck"));
      return;
    }
    const customerId = uuidv7();
    const body = { id: customerId, name: name.trim(), ...(checked?.ok ? { phone: checked.e164 } : { isWalkIn: true }) };
    setSaving(true);
    try {
      const response = await api("/api/v1/customers", { method: "POST", headers: { [IDEMPOTENCY_HEADER]: customerId }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        const customer = payload.data.customer;
        onAdded({ id: customer.id, name: customer.name, credit: customer.credit });
        return;
      }
      if (payload?.error?.code === "DUPLICATE_PHONE") {
        // Already a customer: the picker shows them so they can be picked.
        onAlreadyCustomer(phone.trim());
        return;
      }
      setMessage(payload?.error?.message ?? t("newCustomerFailed"));
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
        // No network: the customer is saved on the phone and sent before the sale that uses them.
        await enqueue(access.owner, "customer.create", body);
        onAdded({ id: customerId, name: body.name, credit: { allowed: false, limitMinor: null } });
      } else {
        setMessage(t("newCustomerFailed"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-card border border-border p-3">
      <p className="text-sm font-medium">{t("newCustomerTitle")}</p>
      <FormField id={`${id}-new-name`} label={t("newCustomerNameLabel")}>
        <NameInput id={`${id}-new-name`} value={name} maxLength={160} onChange={(event) => setName(event.target.value)} />
      </FormField>
      <FormField id={`${id}-new-phone`} label={t("newCustomerPhoneLabel")} hint={t("newCustomerPhoneHint")}>
        <PhoneInput id={`${id}-new-phone`} country={place.country} value={phone} maxLength={32} onChange={(event) => setPhone(event.target.value)} />
      </FormField>
      {message ? <p className="text-sm text-muted">{message}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={saving} onClick={() => void add()}>
          {saving ? t("saving") : t("newCustomerSave")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("newCustomerCancel")}
        </Button>
      </div>
    </div>
  );
}
