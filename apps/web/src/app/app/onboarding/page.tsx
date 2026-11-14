"use client";

import { Button, Card, FormField, Input, PageHeader, Select } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { AddressFields } from "../../../components/address-fields";
import { api } from "../../../lib/api";
import { addressPayload } from "../../../lib/address-client";
import { emptyAddress, type AddressValue, type CountryOption, type SubdivisionOption } from "../../../lib/reference";

type Pack = { code: string; name: string };

export default function OnboardingPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [subdivisions, setSubdivisions] = useState<SubdivisionOption[]>([]);
  const [industries, setIndustries] = useState<Pack[]>([]);
  const [organizationName, setOrganizationName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [branchName, setBranchName] = useState("Main");
  const [industryCode, setIndustryCode] = useState("general-retail");
  const [currency, setCurrency] = useState("NGN");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<AddressValue>(emptyAddress());
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [timezoneTouched, setTimezoneTouched] = useState(false);

  useEffect(() => {
    void (async () => {
      const [countryResponse, industryResponse, meResponse, businessResponse] = await Promise.all([
        api("/api/v1/reference/countries"),
        fetch("/api/v1/catalogs/industry-packs").then((response) => response.json()),
        api("/api/v1/auth/me"),
        api("/api/v1/businesses"),
      ]);
      const countryPayload = countryResponse.ok ? await countryResponse.json() : { data: { items: [] } };
      const loaded = (countryPayload.data?.items ?? []) as CountryOption[];
      setCountries(loaded);
      setIndustries(industryResponse.data?.items ?? []);
      const me = meResponse.ok ? await meResponse.json() : null;
      if (me?.data?.onboardingCompleted) {
        router.replace("/app");
        return;
      }
      const orgName = me?.data?.organization?.name ?? "";
      setOrganizationName(orgName);
      setBusinessName(orgName);
      const businesses = businessResponse.ok ? (await businessResponse.json()).data?.items ?? [] : [];
      const business = businesses[0];
      const countryCode = business?.countryCode?.trim?.() ?? business?.countryCode ?? "NG";
      const country = loaded.find((item) => item.code === countryCode);
      setAddress(emptyAddress(countryCode));
      if (business?.baseCurrencyCode) setCurrency(String(business.baseCurrencyCode).trim());
      if (country?.timezones[0]) setTimezone(country.timezones[0]);
      else if (business?.timezone) setTimezone(business.timezone);
      if (countryCode) {
        const subdivisionResponse = await api(`/api/v1/reference/countries/${countryCode}/subdivisions`);
        if (subdivisionResponse.ok) {
          setSubdivisions((await subdivisionResponse.json()).data?.items ?? []);
        }
      }
    })();
  }, [router]);

  async function onAddressChange(next: AddressValue) {
    const countryChanged = next.countryCode !== address.countryCode;
    setAddress(next);
    if (!countryChanged) return;
    const country = countries.find((item) => item.code === next.countryCode);
    if (country && !currencyTouched) setCurrency(country.defaultCurrencyCode);
    if (country && !timezoneTouched && country.timezones[0]) setTimezone(country.timezones[0]);
    const subdivisionResponse = await api(`/api/v1/reference/countries/${next.countryCode}/subdivisions`);
    setSubdivisions(subdivisionResponse.ok ? (await subdivisionResponse.json()).data?.items ?? [] : []);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await api("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({
        organizationName,
        businessName,
        branchName,
        countryCode: address.countryCode,
        industryCode,
        baseCurrencyCode: currency,
        timezone,
        phoneE164: phone || undefined,
        address: addressPayload(address),
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.fieldErrors?.[0]?.message ?? payload.error?.message ?? "Unable to finish setup.");
      return;
    }
    router.push("/app");
  }

  const country = countries.find((item) => item.code === address.countryCode);
  const zones = country?.timezones ?? [timezone];

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Set up your business"
        description="Confirm the country, address, currency, and timezone. You can change the currency and timezone after the country fills them in."
      />
      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          <FormField id="organizationName" label="Organization name">
            <Input id="organizationName" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} required />
          </FormField>
          <FormField id="businessName" label="Trading name">
            <Input id="businessName" value={businessName} onChange={(event) => setBusinessName(event.target.value)} required />
          </FormField>
          <FormField id="branchName" label="Main branch">
            <Input id="branchName" value={branchName} onChange={(event) => setBranchName(event.target.value)} required />
          </FormField>
          <AddressFields
            idPrefix="onboarding"
            countries={countries}
            subdivisions={subdivisions}
            value={address}
            onChange={(next) => void onAddressChange(next)}
          />
          <FormField id="phone" label="Phone" hint={country?.callingCode ? `Calling code ${country.callingCode}` : "International format"}>
            <Input id="phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder={country?.callingCode ? `${country.callingCode}8012345678` : "+2348012345678"} />
          </FormField>
          <FormField id="industryCode" label="Industry">
            <Select id="industryCode" value={industryCode} onChange={(event) => setIndustryCode(event.target.value)}>
              {industries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id="currency" label="Currency">
            <Input
              id="currency"
              value={currency}
              maxLength={3}
              onChange={(event) => {
                setCurrencyTouched(true);
                setCurrency(event.target.value.toUpperCase());
              }}
              required
            />
          </FormField>
          <FormField id="timezone" label="Timezone">
            <Select
              id="timezone"
              value={timezone}
              onChange={(event) => {
                setTimezoneTouched(true);
                setTimezone(event.target.value);
              }}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </FormField>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Finish setup"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
