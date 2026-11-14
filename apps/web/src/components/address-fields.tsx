"use client";

import { Combobox, FormField, Input } from "@bizora/ui";
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
  const country = countries.find((item) => item.code === value.countryCode);
  const label = country?.subdivisionLabel ?? "State";
  return (
    <div className="space-y-4">
      <FormField id={`${idPrefix}-country`} label="Country">
        <Combobox
          id={`${idPrefix}-country`}
          label="Country"
          items={countries.map((item) => ({ value: item.code, label: item.name }))}
          value={value.countryCode}
          onValueChange={(countryCode) => onChange({ ...value, countryCode, subdivisionCode: "" })}
        />
      </FormField>
      <FormField id={`${idPrefix}-line1`} label="Address line 1">
        <Input
          id={`${idPrefix}-line1`}
          value={value.line1}
          onChange={(event) => onChange({ ...value, line1: event.target.value })}
        />
      </FormField>
      <FormField id={`${idPrefix}-line2`} label="Address line 2" hint="Optional">
        <Input
          id={`${idPrefix}-line2`}
          value={value.line2}
          onChange={(event) => onChange({ ...value, line2: event.target.value })}
        />
      </FormField>
      <FormField id={`${idPrefix}-city`} label="City">
        <Input
          id={`${idPrefix}-city`}
          value={value.city}
          onChange={(event) => onChange({ ...value, city: event.target.value })}
        />
      </FormField>
      {subdivisions.length > 0 ? (
        <FormField id={`${idPrefix}-subdivision`} label={label} hint={country?.subdivisionRequired ? "Required" : "Optional"}>
          <Combobox
            id={`${idPrefix}-subdivision`}
            label={label}
            items={subdivisions.map((item) => ({ value: item.code, label: item.name }))}
            value={value.subdivisionCode}
            placeholder={`Search ${label.toLowerCase()}`}
            onValueChange={(subdivisionCode) => onChange({ ...value, subdivisionCode })}
          />
        </FormField>
      ) : null}
      <FormField
        id={`${idPrefix}-postal`}
        label="Postal code"
        hint={country?.postalCodeRequired ? "Required" : "Optional"}
      >
        <Input
          id={`${idPrefix}-postal`}
          value={value.postalCode}
          onChange={(event) => onChange({ ...value, postalCode: event.target.value })}
        />
      </FormField>
    </div>
  );
}
