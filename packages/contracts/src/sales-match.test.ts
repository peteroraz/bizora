import { describe, expect, it } from "vitest";
import { matchSaleItems, namesFromText, savedItemKey, unitPriceFromTotal } from "./index.js";

describe("quick catalog names and search", () => {
  it("treats spacing, case and a trailing dot as the same name, and keeps sizes apart", () => {
    expect(savedItemKey("Ogbono")).toBe("ogbono");
    expect(savedItemKey("  ogbono  ")).toBe("ogbono");
    expect(savedItemKey("OGBONO")).toBe("ogbono");
    expect(savedItemKey("Ogbono.")).toBe("ogbono");
    expect(savedItemKey("Peak Milk 400g")).not.toBe(savedItemKey("Peak Milk 900g"));
    expect(savedItemKey("Ogb ono")).not.toBe("ogbono");
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
  });

  it("turns a line total into a unit price", () => {
    expect(unitPriceFromTotal(200_000n, 2000n)).toBe(100_000n);
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
