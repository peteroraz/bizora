import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_IMPORT_COLUMNS, rowsFromCsv } from "@bizora/contracts";
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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  // Several staff are invited; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

const blank = { name: "", category: "", unit: "", price: "", cost: "", quantity: "", lowStock: "", barcode: "", packUnit: "", packSize: "", packPrice: "", sku: "", gtin: "", brand: "", item: "", variant: "", packForSale: "", packForPurchase: "", supplier: "", supplierCode: "", priceList: "", priceListPrice: "" };

describe("ADR-065: product files with codes, brands, variants, suppliers and price lists", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let listId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const send = (rows: Record<string, string>[], dryRun: boolean, token = owner) =>
    request(http).post("/api/v1/imports/products").set(auth(token)).send({ dryRun, rows: rows.map((row) => ({ ...blank, ...row })) });
  const rows = [
    { name: "Peak milk 400g", sku: "PK-400", gtin: "4006381333931", brand: "Peak", category: "Provisions > Milk", unit: "tin", price: "4500", cost: "3800", quantity: "48", packUnit: "carton", packSize: "24", packPrice: "105000", packForSale: "yes", packForPurchase: "no", supplier: "Chika Distributors", supplierCode: "CH-9", priceList: "Wholesale", priceListPrice: "4200" },
    { name: "Polo shirt", variant: "Red / M", sku: "POLO-RM", unit: "piece", price: "8000", quantity: "5" },
    { item: "Polo shirt", variant: "Black / L", sku: "POLO-BL", unit: "piece", price: "8500" },
  ];
  const exported = async (token: string) => {
    const response = await request(http).get("/api/v1/products/export.csv").set(auth(token)).expect(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    return response.text;
  };

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@file.test", password, displayName: "Tunde Owner", organizationName: "Tunde Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Tunde Stores", branchName: "Main" }).expect(200);
    cashier = await invite(http, owner, "cashier@file.test", "CASHIER", branchId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@file.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
    listId = (await request(http).post("/api/v1/pricing/lists").set(auth(owner)).send({ name: "Wholesale" }).expect(201)).body.data.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("checks every new column and says exactly what is wrong", async () => {
    const checked = (
      await send(
        [
          { name: "Bad code", gtin: "4006381333932" },
          { name: "Bad answer", packUnit: "carton", packSize: "12", packForSale: "maybe" },
          { name: "No pack", packForSale: "yes" },
          { name: "Unknown list", priceList: "Retail VIP", priceListPrice: "100" },
          { name: "Half list", priceList: "Wholesale" },
          { name: "Code only", supplierCode: "X1" },
          { name: "Deep", category: "A > B > C > D" },
        ],
        true,
      ).expect(200)
    ).body.data;
    const fields = checked.results.map((row: { errors: { field: string }[] }) => row.errors.map((error) => error.field));
    expect(fields).toEqual([["gtin"], ["packForSale"], ["packUnit"], ["priceList"], ["priceListPrice"], ["supplier"], ["category"]]);
  });

  it("saves codes, brand, category path, pack flags, supplier code, list price and variants under one item", async () => {
    const plan = (await send(rows, true).expect(200)).body.data;
    expect(plan.results.map((row: { status: string; message: string }) => [row.status, row.message])).toEqual([
      ["create", "New product with 48 tin in stock."],
      ["create", "New variant Red / M of Polo shirt with 5 piece in stock."],
      ["create", "New variant Black / L of Polo shirt."],
    ]);
    await send(rows, false).expect(200);
    const found = (await request(http).get("/api/v1/products?q=Peak").set(auth(owner)).expect(200)).body.data.items[0];
    const milk = (await request(http).get(`/api/v1/products/${found.id}`).set(auth(owner)).expect(200)).body.data.product;
    expect(milk).toMatchObject({ sku: "PK-400", gtin: "4006381333931" });
    expect(milk.packs[0]).toMatchObject({ unitCode: "carton", forSale: true, forPurchase: false });
    const item = (await request(http).get(`/api/v1/catalog/items/${milk.catalogItemId}`).set(auth(owner)).expect(200)).body.data.item;
    expect({ brand: item.brandName, path: item.categoryPath }).toEqual({ brand: "Peak", path: "Provisions › Milk" });
    const suppliers = (await request(http).get(`/api/v1/products/${milk.id}/suppliers`).set(auth(owner)).expect(200)).body.data;
    expect(JSON.stringify(suppliers)).toContain("CH-9");
    const prices = (await request(http).get(`/api/v1/pricing/lists/${listId}/prices`).set(auth(owner)).expect(200)).body.data;
    expect(JSON.stringify(prices)).toContain("420000");
    const polo = (await request(http).get("/api/v1/catalog/items?q=Polo").set(auth(owner)).expect(200)).body.data.items;
    expect(polo).toHaveLength(1);
    expect(polo[0].variants.map((variant: { variantLabel: string }) => variant.variantLabel).sort()).toEqual(["Black / L", "Red / M"]);
  });

  it("exports a file the import reads back in unchanged", async () => {
    const text = await exported(owner);
    const read = rowsFromCsv(text, PRODUCT_IMPORT_COLUMNS);
    expect(Object.keys(read.columns).sort()).toEqual(Object.keys(PRODUCT_IMPORT_COLUMNS).sort());
    const byName = new Map(read.rows.map((row) => [row.name, row]));
    expect(byName.get("Peak milk 400g")).toMatchObject({ sku: "PK-400", gtin: "4006381333931", brand: "Peak", category: "Provisions > Milk", unit: "tin", price: "4500", cost: "3800", quantity: "48", packUnit: "carton", packSize: "24", packPrice: "105000", packForSale: "yes", packForPurchase: "no", supplier: "Chika Distributors", supplierCode: "CH-9", priceList: "Wholesale", priceListPrice: "4200" });
    expect(byName.get("Polo shirt Black / L")).toMatchObject({ item: "Polo shirt", variant: "Black / L", sku: "POLO-BL", price: "8500" });
    const again = (await send(read.rows, true).expect(200)).body.data;
    expect(again.results.map((row: { status: string; errors?: unknown }) => [row.status, row.errors ?? null])).toEqual(read.rows.map(() => ["update", null]));
  });

  it("changes only the pack a row names, and keeps a product's other packs and their yes/no", async () => {
    const made = (
      await request(http)
        .post("/api/v1/products")
        .set(auth(owner))
        .send({ name: "Milo 500g", baseUnit: "tin", priceMinor: "300000", packs: [{ unitCode: "carton", baseQuantity: "12", forSale: false }, { unitCode: "dozen", baseQuantity: "12" }] })
        .expect(201)
    ).body.data.product;
    expect(made.packs).toHaveLength(2);
    await send([{ name: "Milo 500g", unit: "tin", packUnit: "dozen", packSize: "12", packPrice: "34000" }], false).expect(200);
    const after = (await request(http).get(`/api/v1/products/${made.id}`).set(auth(owner)).expect(200)).body.data.product;
    expect(after.packs.map((pack: { unitCode: string; priceMinor: string | null; forSale: boolean }) => [pack.unitCode, pack.priceMinor, pack.forSale]).sort()).toEqual([
      ["carton", null, false],
      ["dozen", "3400000", true],
    ]);
  });

  it("leaves cost out for staff who may not see it, and keeps businesses apart", async () => {
    const staff = await exported(cashier);
    expect(staff.split("\r\n")[0]).not.toContain("Cost");
    expect(staff).toContain("Peak milk 400g");
    expect(staff).not.toContain("3800");
    const theirs = await exported(other);
    expect(theirs).not.toContain("Peak");
    expect(theirs.trim().split("\r\n")).toHaveLength(1);
  });
});

async function invite(
  http: Parameters<typeof request>[0],
  ownerToken: string,
  email: string,
  role: string,
  branchId: string,
  businessId: string,
) {
  const invited = await request(http)
    .post("/api/v1/invitations")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ email, role, businessId, branchId })
    .expect(201);
  await request(http)
    .post("/api/v1/invitations/accept")
    .send({ token: invited.body.data.invitation.token, displayName: email, password })
    .expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}
