import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { type CachedProduct, readCatalog, refreshCatalog, searchCatalog } from "./catalog";

const product = (id: string, name: string, extra: Partial<CachedProduct> = {}): CachedProduct => ({
  id,
  name,
  category: "Grains",
  baseUnit: "bag",
  priceMinor: "8500000",
  packs: [],
  lowStockLevel: null,
  barcode: null,
  trackStock: true,
  archived: false,
  ...extra,
});

describe("offline catalogue", () => {
  it("downloads in pages, applies changes since the last time, and searches without network", async () => {
    const pages = [
      { products: [product("p1", "Rice 50kg"), product("p2", "Beans", { barcode: "123" })], balances: [{ productId: "p1", quantity: "12000" }], cursors: { products: "c1", balances: "b1" }, done: false },
      { products: [product("p3", "Garri")], balances: [], cursors: { products: "c2", balances: "b1" }, done: true },
    ];
    const seen: unknown[] = [];
    let call = 0;
    const first = await refreshCatalog("t1", "s1", async (cursors) => {
      seen.push(cursors);
      return { branchId: "s1", currency: "NGN", ...(pages[call++] as (typeof pages)[number]) };
    });
    expect(seen).toEqual([{ products: null, balances: null }, { products: "c1", balances: "b1" }]);
    expect(Object.keys(first.products)).toHaveLength(3);

    // Next time only changes come: Beans archived, Rice sold down.
    await refreshCatalog("t1", "s1", async (cursors) => {
      expect(cursors).toEqual({ products: "c2", balances: "b1" });
      return { branchId: "s1", currency: "NGN", products: [product("p2", "Beans", { archived: true })], balances: [{ productId: "p1", quantity: "9000" }], cursors: { products: "c3", balances: "b2" }, done: true };
    });
    const saved = await readCatalog("t1", "s1");
    expect(saved).not.toBeNull();
    const results = searchCatalog(saved!, "rice");
    expect(results.map((item) => [item.name, item.quantity])).toEqual([["Rice 50kg", "9000"]]);
    expect(searchCatalog(saved!, "").map((item) => item.name)).toEqual(["Garri", "Rice 50kg"]);
    expect(await readCatalog("t1", "other-shop")).toBeNull();
  });
});
