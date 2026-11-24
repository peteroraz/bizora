import { describe, expect, it } from "vitest";
import { uncostedSalesNote } from "./profit-note";

describe("the note under the books' profit", () => {
  it("says what share of sales has no cost", () => {
    expect(uncostedSalesNote("41000000", "900000", "partial")).toEqual({ amountMinor: "900000", percent: 2 });
    expect(uncostedSalesNote("10000000", "200000", "partial")).toEqual({ amountMinor: "200000", percent: 2 });
  });

  it("says less than 1% when the share would round to nothing", () => {
    expect(uncostedSalesNote("100000000", "100", "partial")?.percent).toBe("under1");
  });

  it("stays quiet when every sale has a cost, or there were no sales", () => {
    expect(uncostedSalesNote("1000000", "0", "known")).toBeNull();
    expect(uncostedSalesNote("0", "0", "known")).toBeNull();
    expect(uncostedSalesNote("0", "0", "unknown")).toBeNull();
  });
});
