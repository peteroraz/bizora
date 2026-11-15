import { describe, expect, it } from "vitest";
import { formatAddressDisplay } from "./address.js";
import { normalizePhoneToE164, whatsAppHref } from "./phone.js";
import { businessTypeFromIndustry, deriveTraderSetup, industryForBusinessType } from "./trader.js";

describe("Nigerian phone numbers", () => {
  it("turns a local 0803 number into E.164", () => {
    expect(normalizePhoneToE164("08031234567", "NG")).toBe("+2348031234567");
    expect(normalizePhoneToE164("0803 123 4567", "ng")).toBe("+2348031234567");
    expect(normalizePhoneToE164("+2348031234567", "NG")).toBe("+2348031234567");
  });

  it("rejects a number that is not a real phone", () => {
    expect(normalizePhoneToE164("123", "NG")).toBeNull();
    expect(normalizePhoneToE164("", "NG")).toBeNull();
  });

  it("builds a WhatsApp link without a plus sign", () => {
    const href = whatsAppHref("+2348031234567", "Hello Ada");
    expect(href.startsWith("https://wa.me/2348031234567?text=")).toBe(true);
    expect(decodeURIComponent(href.split("text=")[1] ?? "")).toBe("Hello Ada");
  });
});

describe("address display", () => {
  it("formats a market address the way a trader would say it", () => {
    expect(
      formatAddressDisplay({
        shopNumber: "B12",
        lineOrBlock: "4",
        marketOrPlaza: "Main Market",
        city: "Onitsha",
        subdivisionName: "Anambra",
      }),
    ).toBe("Shop B12, Line 4, Main Market, Onitsha, Anambra");
  });
});

describe("trader setup", () => {
  it("hides stock for services and staff when the owner works alone", () => {
    expect(industryForBusinessType("food")).toBe("hospitality");
    expect(businessTypeFromIndustry("wholesale")).toBe("wholesale");
    const alone = deriveTraderSetup({ businessType: "services", staffCountBand: "1", otherCurrencies: false });
    expect(alone.modules).not.toContain("stock");
    expect(alone.modules).not.toContain("staff");
    expect(alone.modules).toContain("customers");
    expect(alone.staffFeatures).toBe(false);
    expect(alone.multiCurrency).toBe(false);
    const team = deriveTraderSetup({ businessType: "shop", staffCountBand: "2-5", otherCurrencies: true });
    expect(team.staffFeatures).toBe(true);
    expect(team.multiCurrency).toBe(true);
    expect(team.modules).toContain("stock");
  });
});
