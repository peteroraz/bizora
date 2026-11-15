import { describe, expect, it } from "vitest";
import { averageUnitCost, emptyPosition, issueStock, QUANTITY_SCALE, receiveStock } from "./stock-cost.js";

const units = (count: number) => BigInt(count) * QUANTITY_SCALE;

describe("weighted-average stock cost", () => {
  it("averages purchases at different prices", () => {
    // 10 cartons at ₦5,000 then 10 at ₦6,000 → average ₦5,500
    let position = receiveStock(emptyPosition(), units(10), 5_000_00n * 10n);
    position = receiveStock(position, units(10), 6_000_00n * 10n);
    expect(averageUnitCost(position)).toBe(5_500_00n);
    const sale = issueStock(position, units(4));
    expect(sale.costMinor).toBe(22_000_00n);
    expect(sale.position).toEqual({ quantity: units(16), valueMinor: 88_000_00n });
  });

  it("never leaves value behind when the last unit goes", () => {
    // 3 units for ₦100.00 cannot split evenly; selling one at a time must still empty the value.
    let position = receiveStock(emptyPosition(), units(3), 100_00n);
    const costs: bigint[] = [];
    for (let index = 0; index < 3; index += 1) {
      const issued = issueStock(position, units(1));
      costs.push(issued.costMinor);
      position = issued.position;
    }
    expect(costs).toEqual([33_33n, 33_34n, 33_33n]);
    expect(costs.reduce((sum, cost) => sum + cost, 0n)).toBe(100_00n);
    expect(position).toEqual({ quantity: 0n, valueMinor: 0n });
  });

  it("handles part units such as 0.5 kg", () => {
    const position = receiveStock(emptyPosition(), 2500n, 5_000_00n); // 2.5 kg for ₦5,000
    expect(averageUnitCost(position)).toBe(2_000_00n);
    expect(issueStock(position, 500n).costMinor).toBe(1_000_00n);
  });

  it("allows selling more than is on hand and flags it", () => {
    const position = receiveStock(emptyPosition(), units(2), 2_000_00n);
    const sold = issueStock(position, units(3));
    expect(sold.negative).toBe(true);
    expect(sold.costMinor).toBe(3_000_00n);
    expect(sold.position).toEqual({ quantity: -units(1), valueMinor: -1_000_00n });
    expect(issueStock(emptyPosition(), units(1), 750_00n).costMinor).toBe(750_00n);
  });

  it("refuses zero or negative quantities", () => {
    expect(() => receiveStock(emptyPosition(), 0n, 0n)).toThrow();
    expect(() => issueStock(emptyPosition(), -1n)).toThrow();
  });
});
