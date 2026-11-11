"use client";

import { Button, Card, Input } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

type Pack = { code: string; name: string };

export default function OnboardingPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<Pack[]>([]);
  const [industries, setIndustries] = useState<Pack[]>([]);
  const [orgName, setOrgName] = useState("");

  useEffect(() => {
    void Promise.all([
      fetch("/api/v1/catalogs/country-packs").then((r) => r.json()),
      fetch("/api/v1/catalogs/industry-packs").then((r) => r.json()),
      fetch("/api/v1/auth/me", { credentials: "include" }).then((r) => r.json()),
    ]).then(([countryPayload, industryPayload, me]) => {
      setCountries(countryPayload.data?.items ?? []);
      setIndustries(industryPayload.data?.items ?? []);
      setOrgName(me.data?.organization?.name ?? "");
      if (me.data?.onboardingCompleted) router.replace("/app");
    });
  }, [router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        organizationName: form.get("organizationName"),
        businessName: form.get("businessName"),
        countryCode: form.get("countryCode"),
        industryCode: form.get("industryCode"),
        baseCurrencyCode: form.get("baseCurrencyCode"),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        branchName: form.get("branchName"),
        primaryColor: form.get("primaryColor"),
        accentColor: form.get("accentColor"),
        logoUrl: form.get("logoUrl") || "",
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to finish setup.");
      return;
    }
    router.push("/app");
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Set up your business</h1>
      <p className="text-[hsl(var(--muted-foreground))]">
        Confirm country, industry, currency and a simple brand so the workspace is ready to use.
      </p>
      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block text-sm">
            Organization name
            <Input name="organizationName" defaultValue={orgName} required className="mt-1" />
          </label>
          <label className="block text-sm">
            Trading name
            <Input name="businessName" defaultValue={orgName} required className="mt-1" />
          </label>
          <label className="block text-sm">
            Main branch
            <Input name="branchName" defaultValue="Main" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Country
            <select name="countryCode" className="mt-1 h-10 w-full rounded-md border px-3 text-sm" defaultValue="NG">
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
              className="mt-1 h-10 w-full rounded-md border px-3 text-sm"
              defaultValue="general-retail"
            >
              {industries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Base currency
            <Input name="baseCurrencyCode" defaultValue="NGN" maxLength={3} required className="mt-1" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Primary color
              <Input name="primaryColor" defaultValue="#1D4ED8" className="mt-1" />
            </label>
            <label className="block text-sm">
              Accent color
              <Input name="accentColor" defaultValue="#0F172A" className="mt-1" />
            </label>
          </div>
          <label className="block text-sm">
            Logo URL (optional)
            <Input name="logoUrl" type="url" className="mt-1" />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Saving…" : "Finish setup"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
