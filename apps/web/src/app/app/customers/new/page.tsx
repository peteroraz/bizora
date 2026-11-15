"use client";

import { Permission } from "@bizora/contracts";
import { FormField, Input, PageHeader, SafeForm, SubmitButton, Textarea } from "@bizora/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RequireAccess } from "../../../../components/require-access";
import { AddressFields } from "../../../../components/address-fields";
import { api } from "../../../../lib/api";
import { addressPayload, hasPlace } from "../../../../lib/address-client";
import { emptyAddress, loadCountries, loadSubdivisions, type CountryOption, type SubdivisionOption } from "../../../../lib/reference";

function NewCustomerPageScreen() {
  const t = useTranslations("customers");
  const common = useTranslations("common");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [walkIn, setWalkIn] = useState(false);
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [address, setAddress] = useState(emptyAddress("NG"));
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [subdivisions, setSubdivisions] = useState<SubdivisionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
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
    setDuplicateId(null);
    const response = await api("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({
        name,
        isWalkIn: walkIn,
        phone: walkIn ? undefined : phone,
        email: email.trim() || null,
        notesSummary: notes.trim() || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
        ...(hasPlace(address) && address.city.trim() ? { address: addressPayload(address) } : {}),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      window.location.href = `/app/customers/${payload.data.customer.id}`;
      return;
    }
    const existing = payload?.error?.fieldErrors?.find((item: { field: string }) => item.field === "customerId");
    if (response.status === 409 && existing?.message) setDuplicateId(existing.message);
    setError(response.status === 409 ? t("duplicate") : (payload?.error?.message ?? t("failed")));
    setPending(false);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title={t("newTitle")} description={t("newLead")} />
      <SafeForm className="space-y-4" pending={pending} onSubmit={save}>
        <FormField id="customer-name" label={common("name")}>
          <Input id="customer-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={walkIn}
            onChange={(event) => {
              setWalkIn(event.target.checked);
              if (event.target.checked) setPhone("");
            }}
          />
          {t("walkInLabel")}
        </label>
        {walkIn ? null : (
          <FormField id="customer-phone" label={common("phone")}>
            <Input id="customer-phone" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" required />
          </FormField>
        )}
        <FormField id="customer-email" label={common("email")} hint={common("optional")}>
          <Input id="customer-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </FormField>
        <FormField id="customer-tags" label={t("tags")} hint={t("tagsHint")}>
          <Input id="customer-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
        </FormField>
        <FormField id="customer-notes" label={t("notes")} hint={common("optional")}>
          <Textarea id="customer-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
        <AddressFields idPrefix="customer" countries={countries} subdivisions={subdivisions} value={address} onChange={setAddress} />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}{" "}
            {duplicateId ? (
              <Link href={`/app/customers/${duplicateId}`} className="font-medium text-primary">
                {t("openExisting")}
              </Link>
            ) : null}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Link href="/app/customers" className="text-sm font-medium text-muted">
            {t("back")}
          </Link>
          <SubmitButton pending={pending} pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </div>
      </SafeForm>
    </div>
  );
}

export default function NewCustomerPage() {
  return (
    <RequireAccess anyOf={[Permission.CUSTOMERS_MANAGE]}>
      <NewCustomerPageScreen />
    </RequireAccess>
  );
}
