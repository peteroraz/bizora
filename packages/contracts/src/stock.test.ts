import { describe, expect, it } from "vitest";
import {
  parseCountQuantity,
  parseMoneyInput,
  parseQuantity,
  quantityToString,
  splitIntoPacks,
  stockAdjustSchema,
  toBaseQuantity,
} from "./stock.js";

describe("quantities", () => {
  it("parses decimals into thousandths without floating point", () => {
    expect(parseQuantity("2.5")).toBe(2500n);
    expect(parseQuantity("1,200")).toBe(1_200_000n);
    expect(parseQuantity("0.001")).toBe(1n);
    for (const bad of ["0", "-1", "1.2345", "abc", "", "1e3"]) expect(parseQuantity(bad)).toBeNull();
    expect(parseCountQuantity("0")).toBe(0n);
    expect(quantityToString(2500n)).toBe("2.5");
    expect(quantityToString(-1000n)).toBe("-1");
    expect(quantityToString(76_000n)).toBe("76");
  });

  it("converts packs to the base unit and back", () => {
    expect(toBaseQuantity(parseQuantity("3") as bigint, 24_000n)).toBe(72_000n);
    expect(toBaseQuantity(parseQuantity("0.5") as bigint, 50_000n)).toBe(25_000n);
    expect(splitIntoPacks(76_000n, "piece", [{ unitCode: "carton", baseQuantity: 24_000n }])).toEqual([
      { unitCode: "carton", quantity: 3_000n },
      { unitCode: "piece", quantity: 4_000n },
    ]);
    expect(splitIntoPacks(72_000n, "piece", [{ unitCode: "carton", baseQuantity: 24_000n }])).toEqual([{ unitCode: "carton", quantity: 3_000n }]);
    expect(splitIntoPacks(0n, "kg", [])).toEqual([{ unitCode: "kg", quantity: 0n }]);
    expect(splitIntoPacks(-30_000n, "piece", [{ unitCode: "carton", baseQuantity: 24_000n }])).toEqual([
      { unitCode: "carton", quantity: -1_000n },
      { unitCode: "piece", quantity: -6_000n },
    ]);
  });
});

describe("money input", () => {
  it("reads naira amounts as kobo", () => {
    expect(parseMoneyInput("1,500.50")).toBe(150_050n);
    expect(parseMoneyInput("₦2000")).toBe(200_000n);
    expect(parseMoneyInput("N 25")).toBe(2_500n);
    expect(parseMoneyInput("1.234")).toBeNull();
  });
});

describe("stock adjustments", () => {
  it("only accepts reasons that match the direction", () => {
    const base = { productId: "8f0d9c5e-0d7f-4c55-9d3f-2a4b6e7c8d90", quantity: "2", unit: "piece" };
    expect(stockAdjustSchema.safeParse({ ...base, direction: "remove", reason: "damaged" }).success).toBe(true);
    expect(stockAdjustSchema.safeParse({ ...base, direction: "add", reason: "damaged" }).success).toBe(false);
    expect(stockAdjustSchema.safeParse({ ...base, direction: "add", reason: "found" }).success).toBe(true);
  });
});
