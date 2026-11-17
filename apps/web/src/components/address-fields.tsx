"use client";

import { useState } from "react";

import { Combobox, FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import type { AddressValue, CountryOption, SubdivisionOption } from "../lib/reference";

export function AddressFields({
  idPrefix,
  countries,
  subdivisions,
  value,
  onChange,
}: {
  idPrefix: string;
  countries: CountryOption[];
  subdivisions: SubdivisionOption[];
  value: AddressValue;
  onChange: (value: AddressValue) => void;
}) {
  const t = useTranslations("address");
  const common = useTranslations("common");
  const country = countries.find((item) => item.code === value.countryCode);
  const label = country?.subdivisionLabel ?? t("city");
  const nigeria = value.countryCode === "NG";
  const marketFields = (
    <>
      <FormField id={`${idPrefix}-shop`} label={t("shopNumber")} hint={common("optional")}>
        <Input id={`${idPrefix}-shop`} value={value.shopNumber} onChange={(event) => onChange({ ...value, shopNumber: event.target.value })} />
      </FormField>
      <FormField id={`${idPrefix}-line`} label={t("lineOrBlock")} hint={common("optional")}>
        <Input id={`${idPrefix}-line`} value={value.lineOrBlock} onChange={(event) => onChange({ ...value, lineOrBlock: event.target.value })} />
      </FormField>
      <FormField id={`${idPrefix}-market`} label={t("market")} hint={t("marketHint")}>
        <Input
          id={`${idPrefix}-market`}
          value={value.marketOrPlaza}
          onChange={(event) => onChange({ ...value, marketOrPlaza: event.target.value })}
        />
      </FormField>
    </>
  );
  const street = (
    <FormField id={`${idPrefix}-line1`} label={t("street")} hint={nigeria ? common("optional") : undefined}>
      <Input id={`${idPrefix}-line1`} value={value.line1} onChange={(event) => onChange({ ...value, line1: event.target.value })} />
    </FormField>
  );
  // Street, second line and postal code matter less in Nigerian markets: folded unless already filled or required.
  const [more, setMore] = useState(Boolean(value.line1 || value.line2 || value.postalCode));
  const showMore = more || !nigeria || Boolean(country?.postalCodeRequired);
  const state = subdivisions.length > 0 ? (
    <FormField id={`${idPrefix}-subdivision`} label={label} hint={country?.subdivisionRequired ? undefined : common("optional")}>
      <Combobox
        id={`${idPrefix}-subdivision`}
        label={label}
        emptyLabel={common("noMatches")}
        items={subdivisions.map((item) => ({ value: item.code, label: item.name }))}
        value={value.subdivisionCode}
        placeholder={t("searchSubdivision", { label: label.toLowerCase() })}
        onValueChange={(subdivisionCode) => onChange({ ...value, subdivisionCode })}
      />
    </FormField>
  ) : null;
  const city = (
    <FormField id={`${idPrefix}-city`} label={t("city")}>
      <Input id={`${idPrefix}-city`} value={value.city} onChange={(event) => onChange({ ...value, city: event.target.value })} />
    </FormField>
  );
  const extra = (
    <>
      {street}
      <FormField id={`${idPrefix}-line2`} label={t("line2")} hint={common("optional")}>
        <Input id={`${idPrefix}-line2`} value={value.line2} onChange={(event) => onChange({ ...value, line2: event.target.value })} />
      </FormField>
      <FormField id={`${idPrefix}-postal`} label={t("postal")} hint={country?.postalCodeRequired ? undefined : common("optional")}>
        <Input id={`${idPrefix}-postal`} value={value.postalCode} onChange={(event) => onChange({ ...value, postalCode: event.target.value })} />
      </FormField>
    </>
  );
  return (
    <div className="space-y-4">
      <FormField id={`${idPrefix}-country`} label={t("country")}>
        <Combobox
          id={`${idPrefix}-country`}
          label={t("country")}
          emptyLabel={common("noMatches")}
          items={countries.map((item) => ({ value: item.code, label: item.name }))}
          value={value.countryCode}
          placeholder={common("searchCountries")}
          onValueChange={(countryCode) => onChange({ ...value, countryCode, subdivisionCode: "" })}
        />
      </FormField>
      {nigeria ? (
        <>
          {state}
          {city}
          {marketFields}
        </>
      ) : (
        <>
          {street}
          <FormField id={`${idPrefix}-line2`} label={t("line2")} hint={common("optional")}>
            <Input id={`${idPrefix}-line2`} value={value.line2} onChange={(event) => onChange({ ...value, line2: event.target.value })} />
          </FormField>
          {city}
          {state}
          {marketFields}
          <FormField id={`${idPrefix}-postal`} label={t("postal")} hint={country?.postalCodeRequired ? undefined : common("optional")}>
            <Input id={`${idPrefix}-postal`} value={value.postalCode} onChange={(event) => onChange({ ...value, postalCode: event.target.value })} />
          </FormField>
        </>
      )}
      {nigeria ? (
        showMore ? (
          extra
        ) : (
          <button type="button" className="min-h-11 text-sm font-medium text-primary" onClick={() => setMore(true)}>
            {t("moreDetails")}
          </button>
        )
      ) : null}
    </div>
  );
}
