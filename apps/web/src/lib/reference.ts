export type CountryOption = {
  code: string;
  name: string;
  defaultCurrencyCode: string;
  timezones: string[];
  callingCode: string | null;
  subdivisionLabel: string;
  subdivisionRequired: boolean;
  postalCodeRequired: boolean;
  postalCodeRegex: string | null;
};

export type SubdivisionOption = { code: string; name: string; countryCode: string };

export type AddressValue = {
  line1: string;
  line2: string;
  city: string;
  subdivisionCode: string;
  postalCode: string;
  countryCode: string;
  marketOrPlaza: string;
  lineOrBlock: string;
  shopNumber: string;
};

export async function loadCountries(): Promise<CountryOption[]> {
  const response = await fetch("/api/v1/reference/countries", { credentials: "include" });
  if (!response.ok) return [];
  const payload = await response.json();
  return (payload.data?.items ?? []) as CountryOption[];
}

export async function loadSubdivisions(countryCode: string): Promise<SubdivisionOption[]> {
  const response = await fetch(`/api/v1/reference/countries/${countryCode}/subdivisions`, { credentials: "include" });
  if (!response.ok) return [];
  const payload = await response.json();
  return (payload.data?.items ?? []) as SubdivisionOption[];
}

export const emptyAddress = (countryCode = "NG"): AddressValue => ({
  line1: "",
  line2: "",
  city: "",
  subdivisionCode: "",
  postalCode: "",
  countryCode,
  marketOrPlaza: "",
  lineOrBlock: "",
  shopNumber: "",
});
