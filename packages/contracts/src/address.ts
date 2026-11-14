import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import geographyRules from "./geography/rules.json" with { type: "json" };

type CountryRule = {
  subdivisionLabel: string;
  subdivisionRequired: boolean;
  postalRequired: boolean;
  postalRegex: string | null;
  subdivisions: string[];
};

const countries = geographyRules.countries as Record<string, CountryRule>;

export function countryRule(code: string): CountryRule | undefined {
  return countries[code.toUpperCase()];
}

export const phoneE164Schema = z.string().trim().superRefine((value, ctx) => {
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed?.isValid() || parsed.number !== value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enter a valid phone number in international format.",
    });
  }
});

const blankToNull = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

export const addressInputSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: blankToNull,
    city: z.string().trim().min(1).max(120),
    subdivisionCode: z.string().trim().max(16).nullable().optional(),
    postalCode: z.string().trim().max(32).nullable().optional(),
    countryCode: z.string().trim().length(2).toUpperCase(),
  })
  .superRefine((value, ctx) => {
    const country = countries[value.countryCode];
    if (!country) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["countryCode"], message: "Choose a valid country." });
      return;
    }
    const subdivision = value.subdivisionCode?.trim() || null;
    if (country.subdivisionRequired && !subdivision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subdivisionCode"],
        message: `${country.subdivisionLabel} is required.`,
      });
    }
    if (subdivision && !country.subdivisions.includes(subdivision)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subdivisionCode"],
        message: "That subdivision does not belong to the selected country.",
      });
    }
    const postal = value.postalCode?.trim() || "";
    if (country.postalRequired && !postal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["postalCode"], message: "Postal code is required." });
    }
    if (postal && country.postalRegex) {
      if (!new RegExp(`^(?:${country.postalRegex})$`).test(postal)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["postalCode"],
          message: "Postal code does not match the country's format.",
        });
      }
    }
  });

export type AddressInput = z.infer<typeof addressInputSchema>;

export const optionalPhoneSchema = z.union([phoneE164Schema, z.literal(""), z.null()]).optional();
