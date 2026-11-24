import { describe, expect, it } from "vitest";
import { compactItemKey, isExactListedName, matchSaleItems, namesFromText, saleCreateSchema, savedItemKey, unitPriceFromTotal } from "./index.js";

describe("quick catalog names and search", () => {
  it("treats spacing, case and a trailing dot as the same name, and keeps sizes apart", () => {
    expect(savedItemKey("Ogbono")).toBe("ogbono");
    expect(savedItemKey("  ogbono  ")).toBe("ogbono");
    expect(savedItemKey("OGBONO")).toBe("ogbono");
    expect(savedItemKey("Ogbono.")).toBe("ogbono");
    expect(savedItemKey("Peak Milk 400g")).not.toBe(savedItemKey("Peak Milk 900g"));
    expect(savedItemKey("Ogb ono")).not.toBe("ogbono");
    expect(compactItemKey("Ogb ono")).toBe("ogbono");
    expect(compactItemKey("Rice-50kg")).toBe(compactItemKey("Rice 50kg"));
    expect(compactItemKey("Peak Milk 400g")).not.toBe(compactItemKey("Peak Milk 900g"));
  });

  it("reads a pasted name list and skips a heading", () => {
    expect(namesFromText("Product\nOgbono\nEgusi\n\nCrayfish")).toEqual(["Ogbono", "Egusi", "Crayfish"]);
    expect(namesFromText("Ogbono,2000\nEgusi")).toEqual(["Ogbono", "Egusi"]);
  });

  it("ranks an exact name ahead of a prefix, and a frequent item ahead of a rare one", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const items = [
      { item: "powder", name: "Ogbono Powder", timesSold: 1, managed: true },
      { item: "ogbono", name: "Ogbono", timesSold: 37, lastSoldAt: "2026-11-22T12:00:00Z" },
      { item: "seeds", name: "Ogbono Seeds", timesSold: 0, managed: true },
      { item: "other", name: "Peak Milk 400g", aliases: ["Peak tin"] },
    ];
    expect(matchSaleItems("Ogb", items, 8, now).map((hit) => hit.item)).toEqual(["ogbono", "powder", "seeds"]);
    expect(matchSaleItems("ogbono", items, 8, now)[0]).toMatchObject({ item: "ogbono", via: "exact" });
    expect(matchSaleItems("Peak tin", items, 8, now)[0]).toMatchObject({ item: "other", via: "alias" });
    expect(matchSaleItems("Uziza", items, 8, now)).toEqual([]);
    const mixed = [
      { item: "prefix", name: "Rice 50kg special", timesSold: 80, managed: true, lastSoldAt: "2026-11-22T12:00:00Z" },
      { item: "rice", name: "Bag of rice", aliases: ["Rice 50kg"], timesSold: 0 },
    ];
    expect(matchSaleItems("Rice 50kg", mixed, 8, now)[0]).toMatchObject({ item: "rice", via: "alias" });
    expect(isExactListedName("rice 50kg", "Rice 50kg")).toBe(true);
    expect(isExactListedName("big rice", "Rice 50kg", ["Big rice"])).toBe(true);
    expect(isExactListedName("rice", "Rice 50kg")).toBe(false);
    expect(isExactListedName("rice50kg", "Rice 50kg")).toBe(true);
    expect(isExactListedName("big-rice", "Rice 50kg", ["Big rice"])).toBe(true);
    expect(matchSaleItems("rice50kg", [{ item: "rice", name: "Rice 50kg", managed: true }], 8, now)[0]).toMatchObject({ item: "rice", via: "exact" });
  });

  it("shows a unit price for a typed line total, and does not treat that figure as the total", () => {
    expect(unitPriceFromTotal(200_000n, 2000n)).toBe(100_000n);
    // 3 cups for ₦2,000 is ₦666.66 on screen. The sale sends 200000, not 199998.
    expect(unitPriceFromTotal(200_000n, 3000n)).toBe(66_666n);
    const typed = saleCreateSchema.parse({
      lines: [{ description: "Ogbono", quantity: "3", unit: "cup", unitPriceMinor: "66666", lineTotalMinor: "200000", saved: true }],
      payments: [{ method: "cash", amountMinor: "200000" }],
    });
    expect(typed.lines[0]).toMatchObject({ lineTotalMinor: "200000" });
    expect(() =>
      saleCreateSchema.parse({
        lines: [{ productId: "018f1b3a-7c2d-7a11-8b22-123456789abc", quantity: "1", unit: "bag", lineTotalMinor: "200000" }],
        payments: [{ method: "cash", amountMinor: "200000" }],
      }),
    ).toThrow();
  });

  it("ranks ten thousand names quickly", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({ item: index, name: `Item ${index}`, timesSold: index % 50 }));
    items.push({ item: 10_000, name: "Ogbono", timesSold: 40 });
    const started = Date.now();
    const found = matchSaleItems("Ogb", items, 8);
    expect(Date.now() - started).toBeLessThan(200);
    expect(found[0]?.item).toBe(10_000);
  });
});
