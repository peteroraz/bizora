"use client";

import { Button, Card, Combobox, FormField, Input, Select } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

type Country = { code: string; name: string; defaultCurrencyCode: string; timezones: string[] };
type Pack = { code: string; name: string };

export default function SetupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [industries, setIndustries] = useState<Pack[]>([]);
  const [countryCode, setCountryCode] = useState("NG");
  const [currency, setCurrency] = useState("NGN");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [industryCode, setIndustryCode] = useState("general-retail");

  useEffect(() => {
    void Promise.all([
      fetch("/api/v1/public/reference/countries").then((response) => response.json()),
      fetch("/api/v1/catalogs/industry-packs").then((response) => response.json()),
    ]).then(([countryPayload, industryPayload]) => {
      const items = (countryPayload.data?.items ?? []) as Country[];
      setCountries(items);
      setIndustries(industryPayload.data?.items ?? []);
      const nigeria = items.find((item) => item.code === "NG");
      if (!nigeria) return;
      setCurrency(nigeria.defaultCurrencyCode);
      setTimezone(nigeria.timezones[0] ?? "Africa/Lagos");
    });
  }, []);

  function onCountryChange(code: string) {
    setCountryCode(code);
    const country = countries.find((item) => item.code === code);
    if (!country) return;
    setCurrency(country.defaultCurrencyCode);
    setTimezone(country.timezones[0] ?? "");
  }

  const currencyItems = [...new Set(countries.map((item) => item.defaultCurrencyCode))].sort().map((code) => ({
    value: code,
    label: code,
  }));
  const zones = countries.find((item) => item.code === countryCode)?.timezones ?? [timezone];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/auth/organization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        organizationName: form.get("organizationName"),
        countryCode,
        baseCurrencyCode: currency,
        timezone,
        industryCode,
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to create the workspace.");
      return;
    }
    router.push("/app/onboarding");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-8">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Create your Bizora workspace</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <FormField id="organizationName" label="Business name">
            <Input id="organizationName" name="organizationName" required />
          </FormField>
          <FormField id="country" label="Country">
            <Combobox
              id="country"
              label="Country"
              items={countries.map((item) => ({ value: item.code, label: item.name }))}
              value={countryCode}
              onValueChange={onCountryChange}
              placeholder="Search countries"
            />
          </FormField>
          <FormField id="currency" label="Currency">
            <Combobox
              id="currency"
              label="Currency"
              items={currencyItems}
              value={currency}
              onValueChange={setCurrency}
              placeholder="Search currencies"
            />
          </FormField>
          <FormField id="timezone" label="Timezone">
            <Combobox
              id="timezone"
              label="Timezone"
              items={zones.map((zone) => ({ value: zone, label: zone }))}
              value={timezone}
              onValueChange={setTimezone}
              placeholder="Search timezones"
            />
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
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
