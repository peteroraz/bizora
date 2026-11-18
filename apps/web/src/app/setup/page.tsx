"use client";

import { Card, Combobox, FormField, SafeForm, SubmitButton } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { PublicFooter } from "../../components/public-footer";
import { NameInput } from "../../components/typing";

type Country = { code: string; name: string; defaultCurrencyCode: string; timezones: string[] };

export default function SetupPage() {
  const t = useTranslations("setup");
  const common = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryCode, setCountryCode] = useState("NG");
  const [currency, setCurrency] = useState("NGN");
  const [timezone, setTimezone] = useState("Africa/Lagos");

  useEffect(() => {
    void fetch("/api/v1/public/reference/countries")
      .then((response) => response.json())
      .then((countryPayload) => {
        const items = (countryPayload.data?.items ?? []) as Country[];
        setCountries(items);
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

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
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
        industryCode: "general-retail",
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    router.push("/app/onboarding");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <SafeForm className="mt-6 space-y-4" pending={pending} onSubmit={onSubmit}>
          <FormField id="organizationName" label={t("business")}>
            <NameInput id="organizationName" name="organizationName" autoComplete="organization" required />
          </FormField>
          <FormField id="country" label={t("country")}>
            <Combobox
              id="country"
              label={t("country")}
              emptyLabel={common("noMatches")}
              items={countries.map((item) => ({ value: item.code, label: item.name }))}
              value={countryCode}
              onValueChange={onCountryChange}
              placeholder={common("searchCountries")}
            />
          </FormField>
          <FormField id="currency" label={t("currency")}>
            <Combobox
              id="currency"
              label={t("currency")}
              emptyLabel={common("noMatches")}
              items={currencyItems}
              value={currency}
              onValueChange={setCurrency}
              placeholder={common("searchCurrencies")}
            />
          </FormField>
          <FormField id="timezone" label={t("timezone")}>
            <Combobox
              id="timezone"
              label={t("timezone")}
              emptyLabel={common("noMatches")}
              items={zones.map((zone) => ({ value: zone, label: zone }))}
              value={timezone}
              onValueChange={setTimezone}
              placeholder={common("searchTimezones")}
            />
          </FormField>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <SubmitButton pending={pending} pendingLabel={t("pending")} className="w-full">
            {t("submit")}
          </SubmitButton>
        </SafeForm>
      </Card>
      <PublicFooter />
    </main>
  );
}
