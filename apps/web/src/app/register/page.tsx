"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Card, Combobox, FormField, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { OauthButtons } from "../../components/oauth-buttons";
import { PasswordWithConfirmation } from "../../components/password-fields";
import { PublicFooter } from "../../components/public-footer";
import { confirmPasswordError } from "../../lib/password";
import { EmailInput, NameInput } from "../../components/typing";

type Country = { code: string; name: string; defaultCurrencyCode: string; timezones: string[] };

export default function RegisterPage() {
  const t = useTranslations("register");
  const common = useTranslations("common");
  const passwordText = useTranslations("password");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryCode, setCountryCode] = useState("NG");
  const [currency, setCurrency] = useState("NGN");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const countryTouched = useRef(false);

  useEffect(() => {
    void fetch("/api/v1/public/reference/countries")
      .then((response) => response.json())
      .then((countryPayload) => {
        const items = (countryPayload.data?.items ?? []) as Country[];
        setCountries(items);
        if (countryTouched.current) return;
        const nigeria = items.find((item) => item.code === "NG");
        if (!nigeria) return;
        setCurrency(nigeria.defaultCurrencyCode);
        setTimezone(nigeria.timezones[0] ?? "Africa/Lagos");
      });
  }, []);

  function onCountryChange(code: string) {
    countryTouched.current = true;
    setCountryCode(code);
    const country = countries.find((item) => item.code === code);
    if (!country) return;
    setCurrency(country.defaultCurrencyCode);
    setTimezone(country.timezones[0] ?? "");
  }

  function mismatchFor(nextPassword: string, nextConfirmation: string) {
    return confirmPasswordError(nextPassword, nextConfirmation) ? passwordText("mismatch") : null;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    if (!event.currentTarget.reportValidity()) return;
    const mismatchError = mismatchFor(password, confirmation);
    const rulesMet = passwordRules.every((rule) => rule.met(password));
    if (mismatchError || !rulesMet) {
      setMismatch(mismatchError);
      setError(rulesMet ? null : t("passwordRules"));
      return;
    }
    setPending(true);
    setError(null);
    setMismatch(null);
    const response = await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: form.get("email"),
        password,
        displayName: form.get("displayName"),
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
        <div className="mt-6">
          <OauthButtons returnTo="/setup" />
        </div>
        <SafeForm className="mt-4 space-y-4" pending={pending} onSubmit={onSubmit}>
          <FormField id="displayName" label={t("name")}>
            <NameInput id="displayName" name="displayName" autoComplete="name" required />
          </FormField>
          <FormField id="organizationName" label={t("business")}>
            <NameInput id="organizationName" name="organizationName" autoComplete="organization" required />
          </FormField>
          <FormField id="email" label={t("email")}>
            <EmailInput id="email" name="email" autoComplete="email" required />
          </FormField>
          <PasswordWithConfirmation
            passwordId="password"
            confirmId="confirmPassword"
            password={password}
            confirmation={confirmation}
            onPasswordChange={(value) => {
              setPassword(value);
              if (confirmation) setMismatch(mismatchFor(value, confirmation));
            }}
            onConfirmationChange={(value) => {
              setConfirmation(value);
              setMismatch(value ? mismatchFor(password, value) : null);
            }}
            mismatch={mismatch}
          />
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
          {/* Currency and time zone follow the country; setup and Settings can change them (6d). */}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <SubmitButton pending={pending} pendingLabel={t("pending")} className="w-full">
            {t("submit")}
          </SubmitButton>
        </SafeForm>
        <p className="mt-4 text-sm">
          {t("already")}{" "}
          <Link href="/login" className="font-medium text-primary">
            {t("signIn")}
          </Link>
        </p>
      </Card>
      <PublicFooter />
    </main>
  );
}
