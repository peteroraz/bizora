"use client";

import { businessTypeSchema, staffCountBandSchema, type BusinessType, type StaffCountBand } from "@bizora/contracts";
import { Button, Card, FormField, Input, SafeForm, Select, SubmitButton } from "@bizora/ui";
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
  pharmacy: "typePharmacy",
  fashion: "typeFashion",
  electronics: "typeElectronics",
  building: "typeBuilding",
  food: "typeFood",
  services: "typeServices",
  other: "typeOther",
} as const;

/** A big tappable choice: the whole card is the target, not a tiny radio dot (6d). */
function Choice({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-control border border-border px-4 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-sidebar-active has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary">
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} />
      <span className={`h-4 w-4 shrink-0 rounded-pill border-2 ${checked ? "border-primary bg-primary" : "border-border"}`} aria-hidden="true" />
      {children}
    </label>
  );
}

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
  const [picked, setPicked] = useState<string[]>([]);
  const [currencyOpen, setCurrencyOpen] = useState(false);
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
        whatYouSell: skipped ? null : [...picked, whatYouSell.trim()].filter(Boolean).join(", ").slice(0, 500) || null,
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

  const buttons = (back: number | null, next: () => void) => (
    <div className="flex gap-3 pt-2">
      {back !== null ? (
        <Button type="button" variant="ghost" onClick={() => setStep(back)}>
          {common("back")}
        </Button>
      ) : null}
      <Button type="button" className="flex-1" size="lg" onClick={next}>
        {common("continue")}
      </Button>
    </div>
  );

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
            <div className="grid gap-2 sm:grid-cols-2">
              {types.map((type) => (
                <Choice key={type} name="businessType" checked={businessType === type} onChange={() => setBusinessType(type)}>
                  {t(typeKey[type])}
                </Choice>
              ))}
            </div>
            {buttons(null, () => setStep(1))}
          </fieldset>
        ) : null}
        {step === 1 ? (
          <div className="mt-6 space-y-4">
            <AddressFields idPrefix="trade" countries={countries} subdivisions={subdivisions} value={place} onChange={changePlace} />
            {buttons(0, () => {
              if (!placeReady()) {
                setError(t("placeRequired"));
                return;
              }
              setError(null);
              setStep(2);
            })}
          </div>
        ) : null}
        {step === 2 ? (
          <div className="mt-6 space-y-4">
            <p className="text-sm">
              {t("mainCurrency", { currency })}{" "}
              <button type="button" className="min-h-11 font-medium text-primary" onClick={() => setCurrencyOpen(true)}>
                {t("changeCurrency")}
              </button>
            </p>
            {currencyOpen ? (
              <FormField id="currency" label={t("currencyLabel")}>
                <Select id="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {currencyCodes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{t("otherCurrencies")}</legend>
              <Choice name="other" checked={otherCurrencies} onChange={() => setOtherCurrencies(true)}>
                {t("otherYes")}
              </Choice>
              <Choice name="other" checked={!otherCurrencies} onChange={() => setOtherCurrencies(false)}>
                {t("otherNo", { currency })}
              </Choice>
            </fieldset>
            {buttons(1, () => setStep(3))}
          </div>
        ) : null}
        {step === 3 ? (
          <fieldset className="mt-6 space-y-2">
            <legend className="sr-only">{t("staffTitle")}</legend>
            {bands.map((band) => (
              <Choice key={band} name="staff" checked={staffCountBand === band} onChange={() => setStaffCountBand(band)}>
                {t(bandKey[band])}
              </Choice>
            ))}
            {buttons(2, () => setStep(4))}
          </fieldset>
        ) : null}
        {step === 4 ? (
          <div className="mt-6 space-y-4">
            <FormField id="shops" label={t("shopsTitle")}>
              <Input id="shops" inputMode="numeric" min={1} value={branchCount} onChange={(event) => setBranchCount(event.target.value)} />
            </FormField>
            {buttons(3, () => setStep(5))}
          </div>
        ) : null}
        {step === 5 ? (
          <SafeForm className="mt-6 space-y-4" onSubmit={finish} pending={pending}>
            {t.has(`sellChoices.${businessType}`) ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("sellPick")}>
                {t(`sellChoices.${businessType}`)
                  .split("|")
                  .map((choice) => {
                    const on = picked.includes(choice);
                    return (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={on}
                        className={`min-h-11 rounded-pill border px-4 text-sm ${on ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
                        onClick={() => setPicked(on ? picked.filter((item) => item !== choice) : [...picked, choice])}
                      >
                        {choice}
                      </button>
                    );
                  })}
              </div>
            ) : null}
            <FormField id="sell" label={t("sellLabel")} hint={common("optional")}>
              <Input id="sell" value={whatYouSell} onChange={(event) => setWhatYouSell(event.target.value)} />
            </FormField>
            <p className="text-sm text-muted">{t("sellNext")}</p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => setStep(4)}>
                {common("back")}
              </Button>
              <Button
                type="submit"
                variant="ghost"
                onClick={() => {
                  skipSell.current = true;
                }}
              >
                {common("skip")}
              </Button>
              <SubmitButton pending={pending} pendingLabel={t("saving")} className="flex-1" size="lg">
                {t("finish")}
              </SubmitButton>
            </div>
          </SafeForm>
        ) : null}
      </Card>
    </main>
  );
}
