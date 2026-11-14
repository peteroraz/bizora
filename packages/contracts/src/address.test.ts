import { describe, expect, it } from "vitest";
import { addressInputSchema, phoneE164Schema } from "./address.js";

describe("address validation", () => {
  it("requires a Nigerian state and rejects a state from another country", () => {
    const missing = addressInputSchema.safeParse({
      line1: "12 Broad Street",
      city: "Lagos",
      countryCode: "NG",
    });
    expect(missing.success).toBe(false);

    const wrong = addressInputSchema.safeParse({
      line1: "12 Broad Street",
      city: "Lagos",
      countryCode: "NG",
      subdivisionCode: "US-NY",
    });
    expect(wrong.success).toBe(false);

    const valid = addressInputSchema.safeParse({
      line1: "12 Broad Street",
      city: "Lagos",
      countryCode: "NG",
      subdivisionCode: "NG-LA",
      postalCode: "100001",
    });
    expect(valid.success).toBe(true);
  });

  it("enforces postal formats where a pattern is defined", () => {
    expect(
      addressInputSchema.safeParse({
        line1: "1 Market Street",
        city: "San Francisco",
        countryCode: "US",
        subdivisionCode: "US-CA",
        postalCode: "12",
      }).success,
    ).toBe(false);
    expect(
      addressInputSchema.safeParse({
        line1: "1 Market Street",
        city: "San Francisco",
        countryCode: "US",
        subdivisionCode: "US-CA",
        postalCode: "94105",
      }).success,
    ).toBe(true);
  });

  it("stores phone numbers as E.164", () => {
    expect(phoneE164Schema.safeParse("+14155552671").success).toBe(true);
    expect(phoneE164Schema.safeParse("4155552671").success).toBe(false);
  });
});