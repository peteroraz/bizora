import { describe, expect, it } from "vitest";
import { formatCount, formatCurrency, formatWhen } from "./format";

describe("en-NG formatting", () => {
  it("formats counts, dates, and naira with Intl", () => {
    expect(formatCount(1200, "en-NG")).toMatch(/1[,.\s]?200/);
    expect(formatCurrency(0n, "NGN", "en-NG")).toMatch(/₦|NGN/);
    const formatted = formatWhen("2026-11-15T16:00:00.000Z", "en-NG", "Africa/Lagos");
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/5:00|17:00/);
  });
});
