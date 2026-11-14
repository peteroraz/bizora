import { describe, expect, it } from "vitest";
import { formatMoney } from "./index.js";

describe("formatMoney", () => {
  it("formats bigint minor units without floating point", () => {
    expect(formatMoney(125_000_000n, "NGN")).toBe("₦1,250,000.00");
    expect(formatMoney(1999n, "USD")).toBe("$19.99");
    expect(formatMoney(125_000_000n, "JPY")).toBe("¥125,000,000");
  });
});