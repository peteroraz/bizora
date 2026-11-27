import "reflect-metadata";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, boot, expectBalancedBooks, product, shop, staff, type Harness, type Shop } from "./test-support.js";

/** ADR-074: items in imported or scanned sales that are not in your products are added as products or services. */
describe("sales import adds new items", () => {
  let harness: Harness;
  let owner: Shop;

  const lagos = (daysAgo: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(Date.now() - daysAgo * 86_400_000));
  const today = lagos(0);
  const yesterday = lagos(1);

  beforeAll(async () => {
    harness = await boot();
    owner = await shop(harness.http, "owner@newitems.test", "A and B Computers");
    await product(harness.http, owner.token, "Rice 50kg", "8000000", "10", "bag");
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  const importSales = (token: string, body: Record<string, unknown>) => request(harness.http).post("/api/v1/imports/sales").set(auth(token)).send(body).expect(200);
  const productNamed = async (name: string) =>
    (
      await harness.client.query<{ id: string; price_minor: string; track_stock: boolean; default_cost_minor: string | null; item_type: string }>(
        "SELECT p.id, p.price_minor::text AS price_minor, p.track_stock, p.default_cost_minor::text AS default_cost_minor, c.item_type FROM products p JOIN catalog_items c ON c.id = p.catalog_item_id WHERE p.tenant_id = $1 AND p.name = $2",
        [owner.tenantId, name],
      )
    ).rows[0];

  const rows = [
    { date: yesterday, product: "DDR4 Laptop RAM", quantity: "1", unit: "piece", price: "60000", payment: "cash", ref: "0681" },
    { date: today, product: "HP ProBook laptop Motherboard repair", quantity: "1", unit: "piece", price: "57800", payment: "transfer", ref: "0683" },
    { date: today, product: "DDR4 laptop RAM", quantity: "1", unit: "piece", price: "65000", payment: "cash", ref: "0682" },
  ];

  it("suggests each new item once, with its latest price, and says which look like services", async () => {
    const checked = await importSales(owner.token, { mode: "full", rows });
    expect(checked.body.data.totals.error).toBe(0);
    expect(checked.body.data.canAddItems).toBe(true);
    expect(checked.body.data.newItems).toEqual([
      { name: "DDR4 Laptop RAM", as: "product", suggested: "product", priceMinor: "6500000", unit: "piece", rows: [1, 3], similar: null },
      { name: "HP ProBook laptop Motherboard repair", as: "service", suggested: "service", priceMinor: "5780000", unit: "piece", rows: [2], similar: null },
    ]);
    expect(await productNamed("DDR4 Laptop RAM")).toBeUndefined();
  });

  it("does not add anything on a save that did not name the new items", async () => {
    const saved = await importSales(owner.token, { mode: "full", rows, dryRun: false });
    expect(saved.body.data.committed).toBe(false);
    expect(saved.body.data.results.map((result: { errors?: { field: string }[] }) => result.errors?.[0]?.field ?? null)).toEqual(["product", "product", "product"]);
    expect(await productNamed("DDR4 Laptop RAM")).toBeUndefined();
  });

  it("adds the named items: a product at its latest price with no stock counting and no cost, and a service", async () => {
    const newItems = [
      { name: "DDR4 Laptop RAM", as: "product" },
      { name: "HP ProBook laptop Motherboard repair", as: "service" },
    ];
    const saved = await importSales(owner.token, { mode: "full", rows, newItems, dryRun: false });
    expect(saved.body.data.committed).toBe(true);
    expect(await productNamed("DDR4 Laptop RAM")).toMatchObject({ price_minor: "6500000", track_stock: false, default_cost_minor: null, item_type: "physical" });
    expect(await productNamed("HP ProBook laptop Motherboard repair")).toMatchObject({ price_minor: "5780000", track_stock: false, item_type: "service" });

    const ram = (await productNamed("DDR4 Laptop RAM"))?.id;
    const lines = await harness.client.query<{ product_id: string | null; cost_minor: string | null }>("SELECT product_id, cost_minor FROM sale_lines WHERE tenant_id = $1 AND description ILIKE 'DDR4%'", [owner.tenantId]);
    expect(lines.rows).toEqual([
      { product_id: ram, cost_minor: null },
      { product_id: ram, cost_minor: null },
    ]);
    const moved = await harness.client.query("SELECT 1 FROM stock_movements WHERE tenant_id = $1 AND product_id = $2", [owner.tenantId, ram]);
    expect(moved.rows).toHaveLength(0);
    await expectBalancedBooks(harness.client, owner.tenantId);

    // The next import sells them as the products they now are.
    const again = await importSales(owner.token, { rows: [{ date: today, product: "ddr4 laptop ram.", quantity: "2", unit: "piece", price: "65000", payment: "cash" }] });
    expect(again.body.data.newItems).toEqual([]);
    expect(again.body.data.totals.error).toBe(0);
  });

  it("keeps an item typed when asked: refused for a counted sale, kept for history", async () => {
    const typed = [{ name: "Laptop bag", as: "typed" }];
    const counted = await importSales(owner.token, { mode: "full", rows: [{ date: today, product: "Laptop bag", price: "9000", payment: "cash" }], newItems: typed, dryRun: false });
    expect(counted.body.data.results[0].errors[0].message).toBe('"Laptop bag" is not in your products. Add it as a product or service, or import this sale as history.');
    const history = await importSales(owner.token, { mode: "history", rows: [{ date: today, product: "Laptop bag", price: "9000", payment: "cash" }], newItems: typed, dryRun: false });
    expect(history.body.data.committed).toBe(true);
    expect(await productNamed("Laptop bag")).toBeUndefined();
  });

  it("adds items from history rows too, without touching stock or the accounts", async () => {
    const saved = await importSales(owner.token, {
      mode: "history",
      rows: [{ date: lagos(30), product: "HDMI cable", quantity: "3", unit: "piece", price: "4500", payment: "cash" }],
      newItems: [{ name: "HDMI cable", as: "product" }],
      dryRun: false,
    });
    expect(saved.body.data.committed).toBe(true);
    expect(await productNamed("HDMI cable")).toMatchObject({ price_minor: "450000", track_stock: false });
    await expectBalancedBooks(harness.client, owner.tenantId);
  });

  it("points out an existing product with a similar name", async () => {
    const checked = await importSales(owner.token, { rows: [{ date: today, product: "Rice 50 kg", unit: "bag", price: "80000", payment: "cash" }] });
    expect(checked.body.data.newItems[0]).toMatchObject({ name: "Rice 50 kg", similar: "Rice 50kg" });
  });

  it("refuses a counted sale in another unit than the new product's latest sale", async () => {
    const checked = await importSales(owner.token, {
      rows: [
        { date: today, product: "Printer paper", quantity: "1", unit: "piece", price: "500", payment: "cash" },
        { date: today, product: "Printer paper", quantity: "1", unit: "carton", price: "24000", payment: "cash" },
      ],
    });
    expect(checked.body.data.results[0].errors[0]).toEqual({ field: "unit", message: '"Printer paper" is sold in carton in its latest sale. Use carton here too, or import this sale as history.' });
    expect(checked.body.data.results[1].status).toBe("create");
  });

  it("links a remembered typed item with the same name to the new product", async () => {
    await request(harness.http)
      .post("/api/v1/sales")
      .set(auth(owner.token))
      .send({ lines: [{ description: "Mouse pad", quantity: "1", unit: "piece", unitPriceMinor: "150000", saved: true }], payments: [{ method: "cash", amountMinor: "150000" }] })
      .expect(201);
    await importSales(owner.token, { rows: [{ date: today, product: "Mouse pad", price: "1800", payment: "cash" }], newItems: [{ name: "Mouse pad", as: "product" }], dryRun: false });
    const saved = await harness.client.query<{ product_id: string | null }>("SELECT product_id FROM saved_items WHERE tenant_id = $1 AND name_key = 'mouse pad'", [owner.tenantId]);
    expect(saved.rows[0]?.product_id).toBe((await productNamed("Mouse pad"))?.id);
  });

  it("does not let a cashier add products: their new items stay typed", async () => {
    const cashier = await staff(harness.http, owner, "cashier@newitems.test", "CASHIER");
    const checked = await importSales(cashier, {
      mode: "history",
      rows: [{ date: today, product: "USB flash 32GB", price: "5000", payment: "cash" }],
      newItems: [{ name: "USB flash 32GB", as: "product" }],
      dryRun: false,
    });
    expect(checked.body.data.canAddItems).toBe(false);
    expect(checked.body.data.newItems[0]).toMatchObject({ as: "typed", suggested: "typed" });
    expect(await productNamed("USB flash 32GB")).toBeUndefined();
  });
});
