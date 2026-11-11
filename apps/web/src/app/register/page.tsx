"use client";

import { Button, Card, Input } from "@bizora/ui";
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
      fetch("/api/v1/catalogs/country-packs").then((r) => r.json()),
      fetch("/api/v1/catalogs/industry-packs").then((r) => r.json()),
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
          <label className="block text-sm">
            Your name
            <Input name="displayName" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Business name
            <Input name="organizationName" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Email
            <Input name="email" type="email" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Password (12+ characters)
            <Input name="password" type="password" minLength={12} required className="mt-1" />
          </label>
          <label className="block text-sm">
            Country
            <select
              className="mt-1 flex h-10 w-full rounded-md border bg-transparent px-3 text-sm"
              value={countryCode}
              onChange={(event) => onCountryChange(event.target.value)}
            >
              {countries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Industry
            <select
              name="industryCode"
              className="mt-1 flex h-10 w-full rounded-md border bg-transparent px-3 text-sm"
              defaultValue="general-retail"
            >
              {industries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Currency: {currency}</p>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          Already registered? <Link href="/login">Sign in</Link>
        </p>
      </Card>
    </main>
  );
}
