"use client";

import { Button, Card, FormField, Input, SafeForm, SubmitButton, Textarea } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatPhone } from "../i18n/format";
import { usePlace } from "../lib/access-context";
import { addressPayload, hasPlace } from "../lib/address-client";
import { api } from "../lib/api";
import { emptyAddress, loadCountries, loadSubdivisions, type AddressValue, type CountryOption, type SubdivisionOption } from "../lib/reference";
import { AddressFields } from "./address-fields";
import { checkTypedPhone, PhoneInput } from "./phone-input";
import { EmailInput, NameInput } from "./typing";

type SavedAddress = {
  line1: string;
  line2: string | null;
  city: string;
  subdivisionCode: string | null;
  postalCode: string | null;
  countryCode: string;
  marketOrPlaza: string | null;
  lineOrBlock: string | null;
  shopNumber: string | null;
} | null;

export type EditableCustomer = {
  id: string;
  name: string;
  phoneE164: string | null;
  isWalkIn: boolean;
  email: string | null;
  tags: string[];
  notesSummary: string | null;
  address?: SavedAddress;
};

const toValue = (address: SavedAddress, country: string): AddressValue =>
  address
    ? {
        line1: address.line1 ?? "",
        line2: address.line2 ?? "",
        city: address.city ?? "",
        subdivisionCode: address.subdivisionCode ?? "",
        postalCode: address.postalCode ?? "",
        countryCode: address.countryCode || country,
        marketOrPlaza: address.marketOrPlaza ?? "",
        lineOrBlock: address.lineOrBlock ?? "",
        shopNumber: address.shopNumber ?? "",
      }
    : emptyAddress(country);

/** Change a customer's name, phone, email, tags, notes and address (7f). Credit is changed in its own panel. */
export function CustomerEdit({ customer, onSaved, onCancel }: { customer: EditableCustomer; onSaved: () => void; onCancel: () => void }) {
  const t = useTranslations("customers");
  const common = useTranslations("common");
  const place = usePlace();
  const [name, setName] = useState(customer.name);
  const [walkIn, setWalkIn] = useState(customer.isWalkIn);
  // Shown the way people type it (0803 123 4567), not as stored (+234…).
  const [phone, setPhone] = useState(customer.phoneE164 ? formatPhone(customer.phoneE164) : "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [tags, setTags] = useState(customer.tags.join(", "));
  const [notes, setNotes] = useState(customer.notesSummary ?? "");
  const [address, setAddress] = useState<AddressValue>(() => toValue(customer.address ?? null, place.country));
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [subdivisions, setSubdivisions] = useState<SubdivisionOption[]>([]);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void loadCountries().then(setCountries);
  }, []);
  useEffect(() => {
    void loadSubdivisions(address.countryCode).then(setSubdivisions);
  }, [address.countryCode]);

  async function save() {
    setPending(true);
    setError(null);
    const checked = walkIn ? null : await checkTypedPhone(phone, place.country);
    if (!walkIn && !checked?.ok) {
      setPhoneError(t("phoneCheck"));
      setPending(false);
      return;
    }
    const response = await api(`/api/v1/customers/${customer.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        isWalkIn: walkIn,
        phone: checked?.ok ? checked.e164 : undefined,
        email: email.trim() || null,
        notesSummary: notes.trim() || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
        ...(hasPlace(address) && address.city.trim() ? { address: addressPayload(address) } : {}),
      }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (response?.ok) return onSaved();
    setError(response ? (response.status === 409 ? t("duplicate") : (payload?.error?.message ?? t("failed"))) : t("editNeedsNetwork"));
  }

  return (
    <Card>
      <SafeForm className="space-y-4" pending={pending} onSubmit={save}>
        <p className="text-sm font-medium">{t("editTitle")}</p>
        <FormField id="edit-customer-name" label={common("name")}>
          <NameInput id="edit-customer-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
        </FormField>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={walkIn}
            onChange={(event) => {
              setWalkIn(event.target.checked);
              if (event.target.checked) setPhone("");
            }}
          />
          {t("walkInLabel")}
        </label>
        {walkIn ? null : (
          <FormField id="edit-customer-phone" label={common("phone")} error={phoneError ?? undefined}>
            <PhoneInput
              id="edit-customer-phone"
              country={place.country}
              value={phone}
              onChange={(event) => {
                setPhoneError(null);
                setPhone(event.target.value);
              }}
              required
            />
          </FormField>
        )}
        <FormField id="edit-customer-email" label={common("email")} hint={common("optional")}>
          <EmailInput id="edit-customer-email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </FormField>
        <FormField id="edit-customer-tags" label={t("tags")} hint={t("tagsHint")}>
          <Input id="edit-customer-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
        </FormField>
        <FormField id="edit-customer-notes" label={t("notes")} hint={common("optional")}>
          <Textarea id="edit-customer-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
        <AddressFields idPrefix="edit-customer" countries={countries} subdivisions={subdivisions} value={address} onChange={setAddress} />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending} pendingLabel={t("saving")}>
            {t("saveChanges")}
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancelEdit")}
          </Button>
        </div>
      </SafeForm>
    </Card>
  );
}
