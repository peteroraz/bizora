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
};

export const emptyAddress = (countryCode = "NG"): AddressValue => ({
  line1: "",
  line2: "",
  city: "",
  subdivisionCode: "",
  postalCode: "",
  countryCode,
});
