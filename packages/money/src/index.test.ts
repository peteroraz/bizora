import { describe, expect, it } from "vitest";
import { add, allocate, convert, fromMinorNumber, money, subtract } from "./index.js";

describe("money primitives", () => {
  it("stores amounts as bigint minor units", () => {
    const tenFifty = money(1050n, "ngn");
    expect(tenFifty.amountMinor).toBe(1050n);
    expect(tenFifty.currencyCode).toBe("NGN");
  });

  it("rejects non-integer minor units from numbers", () => {
    expect(() => fromMinorNumber(10.5, "USD")).toThrow(/whole integers/);
  });

  it("adds and subtracts same-currency amounts", () => {
    const a = money(1000n, "USD");
    const b = money(250n, "USD");
    expect(add(a, b).amountMinor).toBe(1250n);
    expect(subtract(a, b).amountMinor).toBe(750n);
  });

  it("refuses mixed-currency arithmetic", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(/Currency mismatch/);
  });

  it("allocates remainders to the last bucket", () => {
    const parts = allocate(money(100n, "USD"), [1, 1, 1]);
    expect(parts.map((part) => part.amountMinor)).toEqual([33n, 33n, 34n]);
  });

  it("converts using a decimal rate string, not binary float", () => {
    const converted = convert(money(10000n, "NGN"), "USD", "0.0006500000", "2026-11-10");
    expect(converted.fxRate).toBe("0.0006500000");
    expect(converted.baseCurrencyCode).toBe("USD");
    expect(typeof converted.baseAmountMinor).toBe("bigint");
  });
});
