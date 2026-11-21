import { describe, expect, it } from "vitest";
import { parseSpokenSale } from "./spoken-sale.js";

const read = (text: string, currency = "NGN") => parseSpokenSale(text, { currency });
const codes = (text: string, currency = "NGN") => read(text, currency).issues.map((issue) => issue.code);

describe("reading a spoken sale", () => {
  it("reads the brief's first example: a partial payment with a balance", () => {
    const sale = read("I sold five bags of rice at seventy-five thousand naira each to Emeka. He paid three hundred thousand and will balance seventy-five thousand.");
    expect(sale.lines).toEqual([
      expect.objectContaining({ productText: "rice", unit: "bag", quantity: 5000n, unitPriceMinor: 7_500_000n }),
    ]);
    expect(sale.customerText).toBe("Emeka");
    expect(sale.totalMinor).toBe(37_500_000n);
    expect(sale.paidMinor).toBe(30_000_000n);
    expect(sale.balanceMinor).toBe(7_500_000n);
    expect(sale.issues).toEqual([]);
  });

  it("reads the brief's second example: the customer first, the price after a comma", () => {
    const sale = read("Chinedu collected three cartons of Indomie, twelve thousand each, paid twenty thousand, balance sixteen thousand.");
    expect(sale.customerText).toBe("Chinedu");
    expect(sale.lines).toEqual([expect.objectContaining({ productText: "Indomie", unit: "carton", quantity: 3000n, unitPriceMinor: 1_200_000n })]);
    expect(sale.totalMinor).toBe(3_600_000n);
    expect(sale.paidMinor).toBe(2_000_000n);
    expect(sale.balanceMinor).toBe(1_600_000n);
    expect(sale.issues).toEqual([]);
  });

  it("reads a full cash sale", () => {
    const sale = read("Sold two crates of Coke at 3500 each, cash.");
    expect(sale.lines[0]).toMatchObject({ productText: "Coke", unit: "crate", quantity: 2000n, unitPriceMinor: 350_000n });
    expect(sale.payments).toEqual([{ method: "cash", amountMinor: null, methodSaid: true }]);
    expect(sale.paidMinor).toBe(700_000n);
    expect(sale.paidInFull).toBe(true);
    expect(sale.balanceMinor).toBe(0n);
    expect(sale.customerText).toBeNull();
    expect(sale.issues).toEqual([]);
  });

  it("reads several items and a split payment", () => {
    const sale = read("Two bags of rice at 75k each and three cartons of Indomie at 12k each to Mama Ngozi. She paid 150k cash and 36k transfer.");
    expect(sale.lines.map((line) => [line.productText, line.quantity, line.unitPriceMinor])).toEqual([
      ["rice", 2000n, 7_500_000n],
      ["Indomie", 3000n, 1_200_000n],
    ]);
    expect(sale.customerText).toBe("Mama Ngozi");
    expect(sale.payments).toEqual([
      { method: "cash", amountMinor: 15_000_000n, methodSaid: true },
      { method: "transfer", amountMinor: 3_600_000n, methodSaid: true },
    ]);
    expect(sale.totalMinor).toBe(18_600_000n);
    expect(sale.balanceMinor).toBe(0n);
    expect(sale.issues).toEqual([]);
  });

  it("reads a price for all of them, and works out the price of one", () => {
    const sale = read("Three cartons of Indomie for thirty six thousand, paid by POS.");
    expect(sale.lines[0]).toMatchObject({ quantity: 3000n, lineTotalMinor: 3_600_000n, unitPriceMinor: 1_200_000n });
    expect(sale.payments).toEqual([{ method: "pos", amountMinor: null, methodSaid: true }]);
    expect(sale.paidMinor).toBe(3_600_000n);
  });

  it("reads units after the product and 'a bag of…'", () => {
    expect(read("five rice bags at 75k each").lines[0]).toMatchObject({ productText: "rice", unit: "bag", quantity: 5000n });
    expect(read("a bag of Dangote cement 9500").lines[0]).toMatchObject({ productText: "Dangote cement", unit: "bag", quantity: 1000n, unitPriceMinor: 950_000n });
    expect(read("2 Indomie carton at 12k each").lines[0]).toMatchObject({ productText: "Indomie", unit: "carton" });
  });

  it("reads a sale on credit", () => {
    const sale = read("Gave Musa four bags of sugar at 60k each on credit");
    expect(sale.onCredit).toBe(true);
    expect(sale.paidMinor).toBe(0n);
    expect(sale.balanceMinor).toBe(24_000_000n);
  });

  it("never guesses what was not said", () => {
    const sale = read("five bags of rice to Emeka");
    expect(sale.lines[0]).toMatchObject({ unitPriceMinor: null, lineTotalMinor: null });
    expect(sale.totalMinor).toBeNull();
    expect(sale.paidMinor).toBeNull();
    expect(codes("five bags of rice to Emeka")).toEqual(["no_price", "no_payment"]);
    expect(codes("bag of rice at 75k cash")).toContain("no_items");
  });

  it("flags totals and payments that do not add up", () => {
    expect(codes("five bags of rice at 75k each, total 400k, paid in full")).toContain("total_mismatch");
    expect(codes("five bags of rice at 75k each, paid 300k, balance 50k")).toEqual(["payment_mismatch"]);
    expect(codes("two bags of rice at 75k each, paid 200k")).toEqual(["overpaid"]);
  });

  it("flags an amount that could be for one or for all", () => {
    const sale = read("two bags of rice 150k cash");
    expect(sale.lines[0]).toMatchObject({ unclearAmountMinor: 15_000_000n, unitPriceMinor: null });
    expect(sale.issues.map((issue) => issue.code)).toContain("unclear_price");
  });

  it("flags money said in another currency", () => {
    expect(codes("two bags of rice at 50 dollars each, cash")).toContain("currency_mismatch");
    // The business's own currency is fine, whatever it is.
    expect(codes("two bags of rice at 300 cedis each, cash", "GHS")).toEqual([]);
  });

  it("works for currencies without decimals", () => {
    const sale = read("three bags of rice at 15000 each, cash", "XOF");
    expect(sale.lines[0]?.unitPriceMinor).toBe(15_000n);
    expect(sale.totalMinor).toBe(45_000n);
  });

  it("keeps half and decimal quantities exact", () => {
    expect(read("one and a half kg of meat at 6000 per kg cash").lines[0]).toMatchObject({ quantity: 1500n, unit: "kg", unitPriceMinor: 600_000n });
    expect(read("one and a half kg of meat at 6000 per kg cash").totalMinor).toBe(900_000n);
    expect(read("2.5 litres of palm oil at 2000 each").lines[0]).toMatchObject({ quantity: 2500n, unit: "litre" });
  });

  it("reads a customer named with 'customer is…'", () => {
    expect(read("Customer is Alhaji Musa. Ten bags of cement at 9500 each, transfer.").customerText).toBe("Alhaji Musa");
  });

  it("reads words speech-to-text writes for what was said (heard by Whisper on a recording)", () => {
    // "two" written as "to" or "too", "bags" heard as "backs".
    for (const words of ["Sold to bags of rice at 75,000 naira each, cash.", "Sold too backs of rice at 75,000 naira each, cash.", "Sold two bags of rice at 75 thousand naira each. Cash."]) {
      const sale = read(words);
      expect(sale.lines, words).toEqual([expect.objectContaining({ productText: "rice", unit: "bag", quantity: 2000n, unitPriceMinor: 7_500_000n })]);
      expect(sale.paidInFull, words).toBe(true);
    }
    expect(read("Sold for cartons of Indomie at 12k each, cash.").lines[0]).toMatchObject({ quantity: 4000n, unit: "carton" });
    // A name after "to" is a customer, and "for" after a number or "paid" stays as it is.
    expect(read("Sold two bags of rice to Emeka at 75k each, cash.").customerText).toBe("Emeka");
    expect(read("Sold five bags of rice for 375 thousand, cash.").lines[0]).toMatchObject({ quantity: 5000n, unitPriceMinor: 7_500_000n });
    expect(read("He paid for bags of rice, 75k each.").lines[0]?.quantity ?? null).not.toBe(4000n);
    expect(read("Five tens of Peak Milk at 450 each, cash.").lines[0]).toMatchObject({ quantity: 5000n, unit: "tin" });
  });
});
