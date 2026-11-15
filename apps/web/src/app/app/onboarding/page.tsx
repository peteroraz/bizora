"use client";

import { businessTypeSchema, staffCountBandSchema, type BusinessType, type StaffCountBand } from "@bizora/contracts";
import { Card, FormField, Input, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AddressFields } from "../../../components/address-fields";
import { api } from "../../../lib/api";
import { addressPayload } from "../../../lib/address-client";
import { emptyAddress, loadCountries, loadSubdivisions, type CountryOption, type SubdivisionOption } from "../../../lib/reference";

const types = businessTypeSchema.options;
const bands = staffCountBandSchema.options;

const typeKey = {
  shop: "typeShop",
  "market-stall": "typeMarket",
  wholesale: "typeWholesale",
  food: "typeFood",
  services: "typeServices",
  other: "typeOther",
} as const;

const bandKey = {
  "1": "staff1",
  "2-5": "staff2",
  "6-20": "staff6",
  "21+": "staff21",
} as const;

export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const [step, setStep] = useState(0);
  const [businessType, setBusinessType] = useState<BusinessType>("shop");
  const [place, setPlace] = useState(emptyAddress("NG"));
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [subdivisions, setSubdivisions] = useState<SubdivisionOption[]>([]);
  const [currency, setCurrency] = useState("NGN");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [otherCurrencies, setOtherCurrencies] = useState(false);
  const [staffCountBand, setStaffCountBand] = useState<StaffCountBand>("1");
  const [branchCount, setBranchCount] = useState("1");
  const [whatYouSell, setWhatYouSell] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const skipSell = useRef(false);

  useEffect(() => {
    void (async () => {
      const meResponse = await api("/api/v1/auth/me");
      if (!meResponse.ok) return;
      const me = await meResponse.json();
      if (me.data?.onboardingCompleted) {
        window.location.href = "/app";
        return;
      }
      setCountries(await loadCountries());
    })();
  }, []);

  useEffect(() => {
    void loadSubdivisions(place.countryCode).then(setSubdivisions);
  }, [place.countryCode]);

  function changePlace(next: typeof place) {
    if (next.countryCode !== place.countryCode) {
      const country = countries.find((item) => item.code === next.countryCode);
      if (country) {
        setCurrency(country.defaultCurrencyCode);
        setTimezone(country.timezones[0] ?? timezone);
      }
    }
    setPlace(next);
  }

  function placeReady() {
    const country = countries.find((item) => item.code === place.countryCode);
    const located = Boolean(place.line1.trim() || place.marketOrPlaza.trim() || place.shopNumber.trim() || place.lineOrBlock.trim());
    if (!place.city.trim() || !located) return false;
    if (country?.subdivisionRequired && !place.subdivisionCode) return false;
    return true;
  }

  async function finish() {
    const skipped = skipSell.current;
    skipSell.current = false;
    setPending(true);
    setError(null);
    const payload = addressPayload(place);
    const response = await api("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({
        businessType,
        countryCode: payload.countryCode,
        baseCurrencyCode: currency,
        timezone,
        tradeCity: payload.city,
        tradeSubdivisionCode: payload.subdivisionCode,
        ...(payload.marketOrPlaza ? { marketOrPlaza: payload.marketOrPlaza } : {}),
        otherCurrencies,
        staffCountBand,
        branchCount: Number(branchCount) || 1,
        whatYouSell: skipped ? null : whatYouSell.trim() || null,
        address: payload,
      }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      window.location.href = "/app";
      return;
    }
    const field = body?.error?.fieldErrors?.[0]?.message;
    setError(field ?? body?.error?.message ?? t("failed"));
    setPending(false);
  }

  const questions = [t("typeTitle"), t("placeTitle"), t("currencyTitle"), t("staffTitle"), t("shopsTitle"), t("sellTitle")];
  const currencyCodes = [...new Set(countries.map((item) => item.defaultCurrencyCode))].sort();
  if (currency && !currencyCodes.includes(currency)) currencyCodes.unshift(currency);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-8">
      <Card className="w-full">
        <p className="text-sm text-muted">{t("progress", { current: step + 1, total: questions.length })}</p>
        <h1 className="mt-2 text-2xl font-semibold">{questions[step]}</h1>
        {step === 1 ? <p className="mt-2 text-sm text-muted">{t("placeLead")}</p> : null}
        {step === 4 ? <p className="mt-2 text-sm text-muted">{t("shopsHint")}</p> : null}
        {step === 5 ? <p className="mt-2 text-sm text-muted">{t("sellHint")}</p> : null}
        {error ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {step === 0 ? (
          <fieldset className="mt-6 space-y-2">
            <legend className="sr-only">{t("typeTitle")}</legend>
            {types.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input type="radio" name="businessType" checked={businessType === type} onChange={() => setBusinessType(type)} />
                {t(typeKey[type])}
              </label>
            ))}
            <button type="button" className="mt-4 text-sm font-medium text-primary" onClick={() => setStep(1)}>
              {common("continue")}
            </button>
          </fieldset>
        ) : null}
        {step === 1 ? (
          <div className="mt-6 space-y-4">
            <AddressFields idPrefix="trade" countries={countries} subdivisions={subdivisions} value={place} onChange={changePlace} />
            <div className="flex gap-3">
              <button type="button" className="text-sm font-medium text-muted" onClick={() => setStep(0)}>
                {common("back")}
              </button>
              <button
                type="button"
                className="text-sm font-medium text-primary"
                onClick={() => {
                  if (!placeReady()) {
                    setError(t("placeRequired"));
                    return;
                  }
                  setError(null);
                  setStep(2);
                }}
              >
                {common("continue")}
              </button>
            </div>
          </div>
        ) : null}
        {step === 2 ? (
          <div className="mt-6 space-y-4">
            <FormField id="currency" label={t("currencyTitle")}>
              <Select id="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {currencyCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </FormField>
            <fieldset>
              <legend className="text-sm font-medium">{t("otherCurrencies")}</legend>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="radio" name="other" checked={otherCurrencies} onChange={() => setOtherCurrencies(true)} />
                {common("yes")}
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="radio" name="other" checked={!otherCurrencies} onChange={() => setOtherCurrencies(false)} />
                {common("no")}
              </label>
            </fieldset>
            <div className="flex gap-3">
              <button type="button" className="text-sm font-medium text-muted" onClick={() => setStep(1)}>
                {common("back")}
              </button>
              <button type="button" className="text-sm font-medium text-primary" onClick={() => setStep(3)}>
                {common("continue")}
              </button>
            </div>
          </div>
        ) : null}
        {step === 3 ? (
          <fieldset className="mt-6 space-y-2">
            <legend className="sr-only">{t("staffTitle")}</legend>
            {bands.map((band) => (
              <label key={band} className="flex items-center gap-2 text-sm">
                <input type="radio" name="staff" checked={staffCountBand === band} onChange={() => setStaffCountBand(band)} />
                {t(bandKey[band])}
              </label>
            ))}
            <div className="flex gap-3 pt-4">
              <button type="button" className="text-sm font-medium text-muted" onClick={() => setStep(2)}>
                {common("back")}
              </button>
              <button type="button" className="text-sm font-medium text-primary" onClick={() => setStep(4)}>
                {common("continue")}
              </button>
            </div>
          </fieldset>
        ) : null}
        {step === 4 ? (
          <div className="mt-6 space-y-4">
            <FormField id="shops" label={t("shopsTitle")}>
              <Input id="shops" inputMode="numeric" min={1} value={branchCount} onChange={(event) => setBranchCount(event.target.value)} />
            </FormField>
            <div className="flex gap-3">
              <button type="button" className="text-sm font-medium text-muted" onClick={() => setStep(3)}>
                {common("back")}
              </button>
              <button type="button" className="text-sm font-medium text-primary" onClick={() => setStep(5)}>
                {common("continue")}
              </button>
            </div>
          </div>
        ) : null}
        {step === 5 ? (
          <SafeForm className="mt-6 space-y-4" onSubmit={finish} pending={pending}>
            <FormField id="sell" label={t("sellLabel")} hint={common("optional")}>
              <Input id="sell" value={whatYouSell} onChange={(event) => setWhatYouSell(event.target.value)} />
            </FormField>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="text-sm font-medium text-muted" onClick={() => setStep(4)}>
                {common("back")}
              </button>
              <button
                type="submit"
                className="text-sm font-medium text-muted"
                onClick={() => {
                  skipSell.current = true;
                }}
              >
                {common("skip")}
              </button>
              <SubmitButton pending={pending} pendingLabel={t("saving")}>
                {t("finish")}
              </SubmitButton>
            </div>
          </SafeForm>
        ) : null}
      </Card>
    </main>
  );
}
