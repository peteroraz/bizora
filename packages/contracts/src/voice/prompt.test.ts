import { describe, expect, it } from "vitest";
import { speechPrompt } from "./prompt.js";

describe("the words given to the speech model first", () => {
  it("says how money is said here, then the shop's products and customers", () => {
    expect(speechPrompt({ currency: "NGN", products: ["Rice 50kg", "Peak Milk", "Peak Milk", " "], customers: ["Emeka Obi", "Mama Nkechi"] })).toBe(
      "Sold in naira, cash, transfer or POS. Rice 50kg, Peak Milk. Emeka Obi, Mama Nkechi.",
    );
    expect(speechPrompt({ currency: "GHS", products: [], customers: [] })).toBe("Sold in cedi, cash, transfer or POS.");
    expect(speechPrompt({ currency: "XYZ", products: ["Bread"], customers: [] })).toBe("Sold, cash, transfer or POS. Bread.");
  });

  it("stays short enough for Whisper", () => {
    const many = Array.from({ length: 500 }, (_, index) => `Product number ${index}`);
    const text = speechPrompt({ currency: "NGN", products: many, customers: many });
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("Product number 0");
  });
});
