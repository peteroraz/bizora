import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";

const env: AppEnv = {
  NODE_ENV: "test",
  API_PORT: 3001,
  LOG_LEVEL: "error",
  DATABASE_URL: "postgres://bizora:bizora@localhost:5432/bizora_test",
  JWT_SECRET: "test-secret-must-be-at-least-32-chars",
  JWT_ACCESS_TTL: "1h",
  JWT_REFRESH_TTL: "7d",
  WEB_ORIGIN: "http://localhost:3000",
  COOKIE_SECURE: false,
  COOKIE_SAMESITE: "lax",
  THROTTLE_TTL_MS: 60_000,
  THROTTLE_AUTH_LIMIT: 200,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  DEFAULT_PLAN_CODE: "business",
};
const password = "LocalOnly!Passw0rd";
type Http = Parameters<typeof request>[0];

async function owner(http: Http, label: string) {
  const registered = await request(http)
    .post("/api/v1/auth/register")
    .send({ email: `owner.${label}@catalog.test`, password, displayName: `Owner ${label}`, organizationName: `Shop ${label}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
    .expect(201);
  const token = registered.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: `Shop ${label}`, branchName: "Main" })
    .expect(200);
  const me = await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`).expect(200);
  return { token, tenantId: me.body.data.tenant.tenantId as string, businessId: me.body.data.tenant.businessId as string, branchId: me.body.data.tenant.branchId as string };
}

async function staff(http: Http, ownerToken: string, email: string, role: string, branchId: string, businessId: string) {
  const invited = await request(http).post("/api/v1/invitations").set("authorization", `Bearer ${ownerToken}`).send({ email, role, businessId, branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  return (await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201)).body.data.accessToken as string;
}

describe("ADR-046: catalog items, variants, categories, brands and units", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Http;
  let a: Awaited<ReturnType<typeof owner>>;
  let b: Awaited<ReturnType<typeof owner>>;
  let sales = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const books = async (tenantId: string) =>
    (await client.query<{ debit: string; credit: string }>("SELECT coalesce(sum(debit_minor), 0)::text AS debit, coalesce(sum(credit_minor), 0)::text AS credit FROM journal_lines WHERE tenant_id = $1", [tenantId])).rows[0]!;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    a = await owner(http, "a");
    b = await owner(http, "b");
    sales = await staff(http, a.token, "sales@catalog.test", "SALES", a.branchId, a.businessId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("a simple item needs only a name, a price, a quantity and a unit, and sells like any product", async () => {
    const made = await request(http).post("/api/v1/catalog/items").set(auth(a.token)).send({ name: "Peak Milk 400g", variants: [{ priceMinor: "750000", openingQuantity: "12", baseUnit: "tin" }] }).expect(201);
    const item = made.body.data.item;
    expect(item).toMatchObject({ name: "Peak Milk 400g", itemType: "physical", variants: [{ name: "Peak Milk 400g", variantLabel: null, baseUnit: "tin", priceMinor: "750000", quantity: "12000" }] });
    const variant = item.variants[0].id as string;
    await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: variant, quantity: "2", unit: "tin" }], payments: [{ method: "cash", amountMinor: "1500000" }] }).expect(201);
    const product = await request(http).get(`/api/v1/products/${variant}`).set(auth(a.token)).expect(200);
    expect(product.body.data.product.stock.quantity).toBe("10000");
    expect(product.body.data.product.item).toMatchObject({ id: item.id, name: "Peak Milk 400g", itemType: "physical", variants: [{ id: variant }] });
    const totals = await books(a.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it("gives every product made the old way an item of its own, with its typed category", async () => {
    const made = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Golden Penny Semovita 1kg", baseUnit: "bag", priceMinor: "200000", category: "Grains " }).expect(201);
    const product = made.body.data.product;
    expect(product.catalogItemId).toBe(product.id);
    expect(product.item).toMatchObject({ id: product.id, itemType: "physical", categoryPath: "Grains" });
    const categories = await request(http).get("/api/v1/catalog/categories").set(auth(a.token)).expect(200);
    expect(categories.body.data.categories).toEqual([expect.objectContaining({ name: "Grains", depth: 0, itemCount: 1 })]);
    // Same name in another case: the same category, not a second one.
    const again = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Mama Gold Rice", baseUnit: "bag", category: "grains" }).expect(201);
    expect(again.body.data.product.item.categoryId).toBe(product.item.categoryId);
  });

  it("keeps variants apart: own SKU, barcode, price and stock", async () => {
    const made = await request(http)
      .post("/api/v1/catalog/items")
      .set(auth(a.token))
      .send({
        name: "Polo Shirt",
        variants: [
          { variantLabel: "Black / Medium", sku: "POLO-BLK-M", barcode: "2000000000011", baseUnit: "piece", priceMinor: "1200000", openingQuantity: "5" },
          { variantLabel: "White / Large", sku: "POLO-WHT-L", barcode: "2000000000028", baseUnit: "piece", priceMinor: "1300000", openingQuantity: "3" },
        ],
      })
      .expect(201);
    const [black, white] = made.body.data.item.variants as { id: string; name: string; sku: string; priceMinor: string; quantity: string }[];
    expect([black!.name, white!.name]).toEqual(["Polo Shirt Black / Medium", "Polo Shirt White / Large"]);
    await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: black!.id, quantity: "2", unit: "piece" }], payments: [{ method: "cash", amountMinor: "2400000" }] }).expect(201);
    const after = (await request(http).get(`/api/v1/catalog/items/${made.body.data.item.id}`).set(auth(a.token)).expect(200)).body.data.item.variants;
    expect(after.map((variant: { sku: string; quantity: string; priceMinor: string }) => [variant.sku, variant.quantity, variant.priceMinor])).toEqual([
      ["POLO-BLK-M", "3000", "1200000"],
      ["POLO-WHT-L", "3000", "1300000"],
    ]);
    // Search finds the item by SKU, barcode and name.
    for (const q of ["polo-wht-l", "2000000000011", "Polo"]) {
      const found = await request(http).get(`/api/v1/catalog/items?q=${encodeURIComponent(q)}`).set(auth(a.token)).expect(200);
      expect(found.body.data.items.map((item: { name: string }) => item.name), q).toEqual(["Polo Shirt"]);
    }
    // A SKU is used once; a GTIN must have a right check digit.
    const taken = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Another shirt", baseUnit: "piece", sku: "polo-blk-m" }).expect(409);
    expect(taken.body.error.code).toBe("DUPLICATE_SKU");
    await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Bad GTIN", baseUnit: "piece", gtin: "5901234123458" }).expect(400);
    await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Good GTIN", baseUnit: "piece", gtin: "5901234123457" }).expect(201);
    // A third variant, added later.
    const added = await request(http).post(`/api/v1/catalog/items/${made.body.data.item.id}/variants`).set(auth(a.token)).send({ variantLabel: "Black / Large", baseUnit: "piece", priceMinor: "1250000" }).expect(201);
    expect(added.body.data.item.variants).toHaveLength(3);
    await request(http).post(`/api/v1/catalog/items/${made.body.data.item.id}/variants`).set(auth(a.token)).send({ variantLabel: "black / large", baseUnit: "piece" }).expect(409);
  });

  it("nests categories, refuses loops and depth over the limit, and filters an item list by a category and everything under it", async () => {
    const make = async (name: string, parentId?: string) => (await request(http).post("/api/v1/catalog/categories").set(auth(a.token)).send({ name, ...(parentId ? { parentId } : {}) }).expect(201)).body.data.category as { id: string; path: string };
    const food = await make("Food & Beverages");
    const drinks = await make("Drinks", food.id);
    const soft = await make("Soft Drinks", drinks.id);
    expect(soft.path).toBe("Food & Beverages › Drinks › Soft Drinks");
    await request(http).post("/api/v1/catalog/categories").set(auth(a.token)).send({ name: "drinks", parentId: food.id }).expect(409);
    await make("Drinks");
    const loop = await request(http).patch(`/api/v1/catalog/categories/${food.id}`).set(auth(a.token)).send({ parentId: soft.id }).expect(422);
    expect(loop.body.error.code).toBe("CATEGORY_LOOP");
    let deepest = soft;
    for (const name of ["Cans", "Small cans", "Smaller"]) deepest = await make(name, deepest.id);
    const tooDeep = await request(http).post("/api/v1/catalog/categories").set(auth(a.token)).send({ name: "Too deep", parentId: deepest.id }).expect(422);
    expect(tooDeep.body.error.code).toBe("CATEGORY_TOO_DEEP");

    const coke = await request(http).post("/api/v1/catalog/items").set(auth(a.token)).send({ name: "Coke 50cl", categoryId: soft.id, variants: [{ baseUnit: "bottle", priceMinor: "30000" }] }).expect(201);
    expect(coke.body.data.item.categoryPath).toBe("Food & Beverages › Drinks › Soft Drinks");
    const listed = await request(http).get(`/api/v1/catalog/items?categoryId=${food.id}`).set(auth(a.token)).expect(200);
    expect(listed.body.data.items.map((item: { name: string }) => item.name)).toEqual(["Coke 50cl"]);
    // A category no longer in use cannot be chosen, but items already in it stay.
    await request(http).patch(`/api/v1/catalog/categories/${soft.id}`).set(auth(a.token)).send({ active: false }).expect(200);
    await request(http).post("/api/v1/catalog/items").set(auth(a.token)).send({ name: "Fanta 50cl", categoryId: soft.id, variants: [{ baseUnit: "bottle" }] }).expect(422);
    // Renaming a category renames it on its products, for screens that read the old text.
    await request(http).patch(`/api/v1/catalog/categories/${soft.id}`).set(auth(a.token)).send({ name: "Fizzy drinks", active: true }).expect(200);
    const product = await request(http).get(`/api/v1/products/${coke.body.data.item.variants[0].id}`).set(auth(a.token)).expect(200);
    expect(product.body.data.product.category).toBe("Fizzy drinks");
  });

  it("keeps one brand per name, and finds items by brand", async () => {
    const dangote = await request(http).post("/api/v1/catalog/brands").set(auth(a.token)).send({ name: "Dangote", manufacturer: "Dangote Group" }).expect(201);
    const twice = await request(http).post("/api/v1/catalog/brands").set(auth(a.token)).send({ name: "  dangote " }).expect(409);
    expect(twice.body.error.code).toBe("DUPLICATE_BRAND");
    await request(http).post("/api/v1/catalog/brands").set(auth(a.token)).send({ name: "Bad logo", logoUrl: "http://insecure.test/logo.png" }).expect(400);
    await request(http).post("/api/v1/catalog/items").set(auth(a.token)).send({ name: "Dangote Sugar 500g", brandId: dangote.body.data.brand.id, variants: [{ baseUnit: "pack", priceMinor: "120000" }] }).expect(201);
    const found = await request(http).get("/api/v1/catalog/items?q=dangote").set(auth(a.token)).expect(200);
    expect(found.body.data.items).toEqual([expect.objectContaining({ name: "Dangote Sugar 500g", brandName: "Dangote" })]);
  });

  it("services keep no stock, and a stocked item with stock records stays stocked", async () => {
    const service = await request(http).post("/api/v1/catalog/items").set(auth(a.token)).send({ name: "AC Installation", itemType: "service", durationMinutes: 120, variants: [{ baseUnit: "piece", priceMinor: "2500000", openingQuantity: "5" }] }).expect(201);
    expect(service.body.data.item.variants[0]).toMatchObject({ trackStock: false, quantity: null });
    expect(service.body.data.item.details.durationMinutes).toBe(120);
    const movements = await client.query("SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1", [service.body.data.item.variants[0].id]);
    expect(movements.rows[0]).toEqual({ n: 0 });
    const milk = (await request(http).get("/api/v1/catalog/items?q=Peak").set(auth(a.token)).expect(200)).body.data.items[0];
    const locked = await request(http).patch(`/api/v1/catalog/items/${milk.id}`).set(auth(a.token)).send({ itemType: "service" }).expect(422);
    expect(locked.body.error.code).toBe("ITEM_TYPE_LOCKED");
  });

  it("converts packs exactly: buy in cartons only, sell in pieces", async () => {
    const made = await request(http)
      .post("/api/v1/catalog/items")
      .set(auth(a.token))
      .send({ name: "Malt drink", variants: [{ baseUnit: "bottle", priceMinor: "50000", packs: [{ unitCode: "carton", baseQuantity: "24", forSale: false }, { unitCode: "pack", baseQuantity: "6", priceMinor: "290000" }] }] })
      .expect(201);
    const id = made.body.data.item.variants[0].id as string;
    await request(http).post("/api/v1/stock/receive").set(auth(a.token)).send({ productId: id, quantity: "2", unit: "carton", totalCostMinor: "1920000", paidFrom: "cash" }).expect(201);
    const sold = await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: id, quantity: "1", unit: "carton" }], payments: [{ method: "cash", amountMinor: "1200000" }] }).expect(422);
    expect(sold.body.error.code).toBe("UNIT_NOT_FOR_SALE");
    await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: id, quantity: "1", unit: "pack" }, { productId: id, quantity: "5", unit: "bottle" }], payments: [{ method: "cash", amountMinor: "540000" }] }).expect(201);
    const product = await request(http).get(`/api/v1/products/${id}`).set(auth(a.token)).expect(200);
    // 48 bottles in, 6 + 5 out: exactly 37 left, no rounding.
    expect(product.body.data.product.stock.quantity).toBe("37000");
    const totals = await books(a.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it("lets sales staff look items up but not make them or see their cost", async () => {
    const listed = await request(http).get("/api/v1/catalog/items?q=Polo").set(auth(sales)).expect(200);
    expect(listed.body.data.items[0].variants[0]).not.toHaveProperty("defaultCostMinor");
    await request(http).post("/api/v1/catalog/items").set(auth(sales)).send({ name: "Not allowed", variants: [{ baseUnit: "piece" }] }).expect(403);
    await request(http).post("/api/v1/catalog/categories").set(auth(sales)).send({ name: "Not allowed" }).expect(403);
    await request(http).post("/api/v1/catalog/brands").set(auth(sales)).send({ name: "Not allowed" }).expect(403);
  });

  it("never lets one business see, use or change another's items, categories or brands", async () => {
    const category = (await request(http).get("/api/v1/catalog/categories").set(auth(a.token)).expect(200)).body.data.categories[0];
    const brand = (await request(http).get("/api/v1/catalog/brands").set(auth(a.token)).expect(200)).body.data.brands[0];
    const item = (await request(http).get("/api/v1/catalog/items?q=Polo").set(auth(a.token)).expect(200)).body.data.items[0];
    await request(http).get(`/api/v1/catalog/items/${item.id}`).set(auth(b.token)).expect(404);
    await request(http).patch(`/api/v1/catalog/items/${item.id}`).set(auth(b.token)).send({ name: "Taken" }).expect(404);
    await request(http).post(`/api/v1/catalog/items/${item.id}/variants`).set(auth(b.token)).send({ variantLabel: "Mine", baseUnit: "piece" }).expect(404);
    await request(http).post(`/api/v1/catalog/items/${item.id}/archive`).set(auth(b.token)).send({}).expect(404);
    await request(http).patch(`/api/v1/catalog/categories/${category.id}`).set(auth(b.token)).send({ name: "Taken" }).expect(404);
    await request(http).patch(`/api/v1/catalog/brands/${brand.id}`).set(auth(b.token)).send({ name: "Taken" }).expect(404);
    await request(http).post("/api/v1/catalog/items").set(auth(b.token)).send({ name: "Borrow", categoryId: category.id, variants: [{ baseUnit: "piece" }] }).expect(404);
    await request(http).post("/api/v1/catalog/items").set(auth(b.token)).send({ name: "Borrow", brandId: brand.id, variants: [{ baseUnit: "piece" }] }).expect(404);
    await request(http).post("/api/v1/catalog/categories").set(auth(b.token)).send({ name: "Under theirs", parentId: category.id }).expect(404);
    await request(http).post("/api/v1/products").set(auth(b.token)).send({ name: "Borrow", baseUnit: "piece", catalogItemId: item.id, variantLabel: "X" }).expect(404);
    expect((await request(http).get("/api/v1/catalog/items").set(auth(b.token)).expect(200)).body.data.items).toEqual([]);
    expect((await request(http).get("/api/v1/catalog/categories").set(auth(b.token)).expect(200)).body.data.categories).toEqual([]);
    expect((await request(http).get("/api/v1/catalog/brands").set(auth(b.token)).expect(200)).body.data.brands).toEqual([]);
    // And the database refuses a cross-business link even if the code forgot.
    await expect(client.query("UPDATE catalog_items SET category_id = $1 WHERE tenant_id = $2", [category.id, b.tenantId])).resolves.toBeDefined();
    const bItem = await request(http).post("/api/v1/catalog/items").set(auth(b.token)).send({ name: "B's own", variants: [{ baseUnit: "piece" }] }).expect(201);
    await expect(client.query("UPDATE catalog_items SET category_id = $1 WHERE id = $2", [category.id, bItem.body.data.item.id])).rejects.toThrow(/catalog_items_category_fk/);
    await expect(client.query("UPDATE products SET catalog_item_id = $1 WHERE id = $2", [item.id, bItem.body.data.item.variants[0].id])).rejects.toThrow(/products_catalog_item_fk/);
  });

  it("archives an item with its variants, and keeps their history", async () => {
    const item = (await request(http).get("/api/v1/catalog/items?q=Polo").set(auth(a.token)).expect(200)).body.data.items[0];
    await request(http).post(`/api/v1/catalog/items/${item.id}/archive`).set(auth(a.token)).send({ reason: "Stopped selling shirts" }).expect(200);
    expect((await request(http).get("/api/v1/catalog/items?q=Polo").set(auth(a.token)).expect(200)).body.data.items).toEqual([]);
    const rows = await client.query<{ archived: boolean }>("SELECT archived_at IS NOT NULL AS archived FROM products WHERE catalog_item_id = $1", [item.id]);
    expect(rows.rows.every((row) => row.archived)).toBe(true);
    const sold = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sale_lines WHERE product_id = ANY($1::uuid[])", [item.variants.map((variant: { id: string }) => variant.id)]);
    expect(sold.rows[0]!.n).toBe(1);
    const logged = await client.query("SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at", [item.id]);
    expect(logged.rows.map((row) => (row as { action: string }).action)).toEqual(["catalog_item.created", "catalog_item.archived"]);
  });
});

describe("migration 0040 on a database that already has products", () => {
  it("makes one item per product, one category per typed name, and loses nothing", async () => {
    const client = new PGlite();
    const migrations = await loadMigrationSql();
    const before = migrations.filter((migration) => migration.id < "0040");
    for (const migration of before) await client.exec(migration.sql);
    await client.exec(`
      INSERT INTO organizations (id, name, slug, handle) VALUES ('00000000-0000-4000-8000-000000000001', 'Old shop', 'old-shop', 'old-shop');
      INSERT INTO businesses (id, tenant_id, name, country_code, base_currency_code, timezone) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Old shop', 'NG', 'NGN', 'Africa/Lagos');
      INSERT INTO products (id, tenant_id, business_id, name, category, base_unit, track_stock) VALUES
        ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Rice', 'Grains', 'bag', true),
        ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Beans', ' grains', 'bag', true),
        ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Delivery', NULL, 'piece', false);
    `);
    for (const migration of migrations.filter((migration) => migration.id >= "0040")) await client.exec(migration.sql);
    const items = await client.query<{ id: string; item_type: string; category: string | null }>(
      "SELECT i.id, i.item_type, c.name AS category FROM catalog_items i LEFT JOIN categories c ON c.id = i.category_id ORDER BY i.id",
    );
    expect(items.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000000011", item_type: "physical", category: "Grains" },
      { id: "00000000-0000-4000-8000-000000000012", item_type: "physical", category: "Grains" },
      { id: "00000000-0000-4000-8000-000000000013", item_type: "non_stock", category: null },
    ]);
    const products = await client.query<{ id: string; catalog_item_id: string }>("SELECT id, catalog_item_id FROM products ORDER BY id");
    expect(products.rows.every((row) => row.id === row.catalog_item_id)).toBe(true);
    await client.close();
  });
});
