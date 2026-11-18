import { describe, expect, it } from "vitest";
import { checkPhone, dialCode, normalizePhoneToE164, phoneExample, phoneProblemMessage, typePhone } from "./phone.js";
import {
  amountText,
  capitaliseFirst,
  capitaliseWords,
  caretAfterFormat,
  currencyDigits,
  parseAmount,
  tidyEmail,
  tidyName,
  typeAmount,
  typeDigits,
  typeNumber,
} from "./typing.js";

describe("amounts follow the currency", () => {
  it("knows how many decimals each currency uses", () => {
    expect([currencyDigits("NGN"), currencyDigits("GHS"), currencyDigits("XOF"), currencyDigits("JPY"), currencyDigits("KWD")]).toEqual([2, 2, 0, 0, 3]);
    expect(currencyDigits("not-a-currency")).toBe(2);
  });

  it("groups thousands and limits decimals while typing", () => {
    expect(typeAmount("1500.567", "NGN")).toBe("1,500.56");
    expect(typeAmount("₦25000", "NGN")).toBe("25,000");
    expect(typeAmount("12a3.4.5", "NGN")).toBe("123.45");
    expect(typeAmount(".5", "NGN")).toBe("0.5");
    expect(typeAmount("0007", "NGN")).toBe("7");
    expect(typeAmount("1500.5", "XOF")).toBe("15,005");
    expect(typeAmount("1.2345", "KWD")).toBe("1.234");
    expect(typeNumber("1234567", 0)).toBe("1,234,567");
  });

  it("reads a typed amount into the smallest unit", () => {
    expect(parseAmount("1,500.50", "NGN")).toBe(150_050n);
    expect(parseAmount("GH₵ 20", "GHS")).toBe(2_000n);
    expect(parseAmount("15,000", "XOF")).toBe(15_000n);
    expect(parseAmount("1.5", "XOF")).toBeNull();
    expect(parseAmount("2.125", "KWD")).toBe(2_125n);
    expect(parseAmount("", "NGN")).toBeNull();
    expect(parseAmount("abc", "NGN")).toBeNull();
    expect(parseAmount("-5", "NGN")).toBeNull();
  });

  it("puts a saved amount back the way it is typed", () => {
    expect(amountText(150_050n, "NGN")).toBe("1,500.50");
    expect(amountText(150_000n, "NGN")).toBe("1,500");
    expect(amountText(15_000n, "XOF")).toBe("15,000");
  });

  it("keeps the caret after the same digit when commas move", () => {
    // "1000" with the caret at the end, then a fifth digit: "10,000|".
    expect(caretAfterFormat("10000", 5, "10,000")).toBe(6);
    // Caret after the "2" in "1,2|34" stays after the "2" in "12,|34" → after "12,"? It counts digits: after 2 digits.
    expect(caretAfterFormat("1,234", 3, "1,234")).toBe(3);
    expect(caretAfterFormat("", 0, "")).toBe(0);
  });
});

describe("names and other text", () => {
  it("capitalises the first letter of each word as a name is typed", () => {
    expect(capitaliseWords("ada okafor-bello")).toBe("Ada Okafor-Bello");
    expect(capitaliseWords("mama's kitchen")).toBe("Mama's Kitchen");
    expect(capitaliseWords("McDonald DHL")).toBe("McDonald DHL");
    expect(capitaliseWords("émile zola")).toBe("Émile Zola");
    expect(capitaliseWords("ada ")).toBe("Ada ");
  });

  it("tidies a finished name", () => {
    expect(tidyName("  ada   okafor ")).toBe("Ada Okafor");
    expect(tidyName("ADA OKAFOR")).toBe("Ada Okafor");
    expect(tidyName("Ada DHL Logistics")).toBe("Ada DHL Logistics");
    expect(tidyName("UBA")).toBe("UBA");
  });

  it("capitalises only the first letter of a product name", () => {
    expect(capitaliseFirst("indomie chicken 70g")).toBe("Indomie chicken 70g");
  });

  it("tidies emails and digit codes", () => {
    expect(tidyEmail(" Ada.Okafor@Mail.COM ")).toBe("ada.okafor@mail.com");
    expect(typeDigits("12a3-4567", 6)).toBe("123456");
  });
});

describe("phone numbers by country", () => {
  it("accepts a local number and gives E.164", () => {
    expect(normalizePhoneToE164("0803 123 4567", "NG")).toBe("+2348031234567");
    expect(normalizePhoneToE164("024 123 4567", "GH")).toBe("+233241234567");
    expect(normalizePhoneToE164("0712 345678", "KE")).toBe("+254712345678");
    expect(normalizePhoneToE164("06 12 34 56 78", "FR")).toBe("+33612345678");
  });

  it("accepts a number from another country when it starts with its code", () => {
    const result = checkPhone("+233 24 123 4567", "NG");
    expect(result).toMatchObject({ ok: true, e164: "+233241234567", country: "GH" });
    expect(normalizePhoneToE164("00233241234567", "NG")).toBe("+233241234567");
  });

  it("says when a number is too short, too long, or not a real number there", () => {
    expect(checkPhone("0803 123", "NG")).toMatchObject({ ok: false, problem: "too_short", country: "NG" });
    expect(checkPhone("0803 123 4567 89", "NG")).toMatchObject({ ok: false, problem: "too_long" });
    // Right length, but Nigerian numbers do not start like this.
    expect(checkPhone("0103 123 4567", "NG")).toMatchObject({ ok: false, problem: "invalid" });
    expect(checkPhone("", "NG")).toBeNull();
    expect(checkPhone("abc", "NG")).toMatchObject({ ok: false, problem: "invalid" });
  });

  it("formats while typing and gives examples", () => {
    expect(typePhone("08031234567", "NG")).toBe("0803 123 4567");
    expect(typePhone("+233241234567", "NG")).toBe("+233 24 123 4567");
    expect(dialCode("NG")).toBe("+234");
    expect(phoneExample("NG")).toMatch(/^0\d{3} \d{3} \d{4}$/);
    expect(phoneProblemMessage("too_short", "GH")).toMatch(/^This number is too short for Ghana\. Numbers there look like 0/);
  });
});
