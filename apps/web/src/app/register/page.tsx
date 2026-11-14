"use client";

import { Button, Card, FormField, Input, Select } from "@bizora/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

type Pack = { code: string; name: string; defaultCurrencyCode?: string; defaultTimezone?: string };

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<Pack[]>([]);
  const [industries, setIndustries] = useState<Pack[]>([]);
  const [countryCode, setCountryCode] = useState("NG");
  const [currency, setCurrency] = useState("NGN");

  useEffect(() => {
    void Promise.all([
      fetch("/api/v1/catalogs/country-packs").then((response) => response.json()),
      fetch("/api/v1/catalogs/industry-packs").then((response) => response.json()),
    ]).then(([countryPayload, industryPayload]) => {
      setCountries(countryPayload.data?.items ?? []);
      setIndustries(industryPayload.data?.items ?? []);
    });
  }, []);

  function onCountryChange(code: string) {
    setCountryCode(code);
    const pack = countries.find((item) => item.code === code);
    if (pack?.defaultCurrencyCode) setCurrency(pack.defaultCurrencyCode);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const country = countries.find((item) => item.code === countryCode);
    const response = await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        displayName: form.get("displayName"),
        organizationName: form.get("organizationName"),
        countryCode,
        baseCurrencyCode: currency,
        timezone: country?.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        industryCode: form.get("industryCode"),
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to create workspace.");
      return;
    }
    router.push("/app/onboarding");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-8">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Create your Bizora workspace</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <FormField id="displayName" label="Your name">
            <Input id="displayName" name="displayName" required />
          </FormField>
          <FormField id="organizationName" label="Business name">
            <Input id="organizationName" name="organizationName" required />
          </FormField>
          <FormField id="email" label="Email">
            <Input id="email" name="email" type="email" required />
          </FormField>
          <FormField id="password" label="Password" hint="At least 12 characters">
            <Input id="password" name="password" type="password" minLength={12} required />
          </FormField>
          <FormField id="country" label="Country">
            <Select id="country" value={countryCode} onChange={(event) => onCountryChange(event.target.value)}>
              {countries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id="industryCode" label="Industry">
            <Select id="industryCode" name="industryCode" defaultValue="general-retail">
              {industries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </Select>
          </FormField>
          <p className="text-sm text-muted">Currency: {currency}</p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          Already registered?{" "}
          <Link href="/login" className="font-medium text-primary">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
