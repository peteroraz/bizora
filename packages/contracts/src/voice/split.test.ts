import { describe, expect, it } from "vitest";
import { buildReview } from "./review.js";
import { parseSpokenSale } from "./spoken-sale.js";
import { looksLikeSpokenSale, splitSpokenSales } from "./split.js";

const read = (text: string) => parseSpokenSale(text, { currency: "NGN" });

describe("several sales in one go (ADR-057)", () => {
  it("keeps one sale as one, even when it says new customer", () => {
    expect(splitSpokenSales("20 bags of rice 750k for all, 3 cups of ogiri 5,500, 1 carton of indomie 15,000, new customer")).toHaveLength(1);
    expect(splitSpokenSales("Sold 5 bags of rice to Emeka at 75k each. Emeka paid 300k.")).toHaveLength(1);
  });

  it("splits on next customer, another sale and second customer", () => {
    expect(
      splitSpokenSales("Emeka bought 2 bags of rice 75k each, paid cash. Next customer: 3 cups of ogiri 1,500 for all, transfer. Another sale, 1 carton of indomie 15000 cash. Second customer 2 tins of milk 650 each"),
    ).toEqual(["Emeka bought 2 bags of rice 75k each, paid cash.", "3 cups of ogiri 1,500 for all, transfer.", "1 carton of indomie 15000 cash.", "2 tins of milk 650 each"]);
  });

  it("splits a numbered list and blank lines", () => {
    expect(splitSpokenSales("1. 2 bags of rice 150k cash\n2. 3 cups of ogiri 1500 for all transfer\n3) Mama Ngozi 5 tins of milk 650 each")).toEqual([
      "2 bags of rice 150k cash",
      "3 cups of ogiri 1500 for all transfer",
      "Mama Ngozi 5 tins of milk 650 each",
    ]);
    expect(splitSpokenSales("2 bags of rice 150k cash\n\n3 cups of ogiri 1500 for all")).toHaveLength(2);
  });

  it("starts a new sale when a new buyer's sentence follows something sold", () => {
    expect(splitSpokenSales("Chidi took 3 cartons of Indomie, 12 thousand each, paid cash. He said thanks. Mama Ngozi bought 2 tins of milk 650 each, transfer.")).toEqual([
      "Chidi took 3 cartons of Indomie, 12 thousand each, paid cash. He said thanks.",
      "Mama Ngozi bought 2 tins of milk 650 each, transfer.",
    ]);
  });

  it("drops parts with nothing sold in them", () => {
    expect(splitSpokenSales("Next customer.")).toEqual([]);
  });

  it("tells a sale typed in the search box from a product name", () => {
    expect(looksLikeSpokenSale("20 bag of rice , 750,000, 3 cups of ogiri, 5500, 1 catoon of indomie, 15000, new customer")).toBe(true);
    expect(looksLikeSpokenSale("two bags of rice at seventy five thousand each")).toBe(true);
    expect(looksLikeSpokenSale("Golden Penny Semovita 10kg")).toBe(false);
    expect(looksLikeSpokenSale("Rice 50kg")).toBe(false);
  });
});

describe("market wording", () => {
  it("reads an amount followed by for all as the price of all of them", () => {
    const sale = read("20 bags of rice 750k for all, 3 cups of ogiri 5,500 for all, 1 catoon of indomie 15,000");
    expect(sale.lines).toEqual([
      expect.objectContaining({ productText: "rice", unit: "bag", quantity: 20_000n, lineTotalMinor: 75_000_000n }),
      expect.objectContaining({ productText: "ogiri", unit: "cup", quantity: 3_000n, lineTotalMinor: 550_000n }),
      expect.objectContaining({ productText: "indomie", unit: "carton", quantity: 1_000n, unitPriceMinor: 1_500_000n }),
    ]);
  });

  it("reads paint, derica and mudu", () => {
    const sale = read("2 paint of garri 1500 each, 3 derika of crayfish 2500 each, 1 mudu of beans 1200, paid cash");
    expect(sale.lines.map((line) => line.unit)).toEqual(["paint", "derica", "mudu"]);
    expect(sale.totalMinor).toBe(1_170_000n);
  });

  it("keeps an amount for all that does not divide evenly, for a new item", () => {
    const review = buildReview(read("3 cups of ogiri 5,500 for all, paid cash"), [], [], { canChangePrice: false, canGiveCredit: false, typedItems: true });
    expect(review.lines[0]).toEqual(expect.objectContaining({ exactTotalMinor: 550_000n, totalMinor: 550_000n, priceMinor: 183_333n }));
    expect(review.totalMinor).toBe(550_000n);
  });
});
