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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  // Several staff are invited; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
};

const password = "LocalOnly!Passw0rd";

type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string, place = { country: "NG", currency: "NGN", timezone: "Africa/Lagos" }) {
  const industryCode = "general-retail";
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@typing.test`,
      password,
      displayName: `Owner ${label}`,
      organizationName: `Shop ${label}`,
      countryCode: place.country,
      baseCurrencyCode: place.currency,
      timezone: place.timezone,
      industryCode,
    })
    .expect(201);
  const token = owner.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({
      countryCode: place.country,
      industryCode,
      baseCurrencyCode: place.currency,
      timezone: place.timezone,
      businessName: `Shop ${label}`,
      branchName: "Main",
    })
    .expect(200);
  const me = await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`).expect(200);
  return {
    token,
    tenantId: me.body.data.tenant.tenantId as string,
    businessId: me.body.data.tenant.businessId as string,
    branchId: me.body.data.tenant.branchId as string,
  };
}


const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("sprint 7a: typing that fits", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Http;
  let lagos: Awaited<ReturnType<typeof registerOwner>>;
  let dakar: Awaited<ReturnType<typeof registerOwner>>;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    lagos = await registerOwner(http, "lagos");
    dakar = await registerOwner(http, "dakar", { country: "SN", currency: "XOF", timezone: "Africa/Dakar" });
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("refuses a customer phone of the wrong length, and says what the country's numbers look like", async () => {
    const short = await request(http).post("/api/v1/customers").set(auth(lagos.token)).send({ name: "Ada Okafor", phone: "0803 123" }).expect(400);
    expect(short.body.error.fieldErrors[0]).toMatchObject({ field: "phone" });
    expect(short.body.error.fieldErrors[0].message).toMatch(/^This number is too short for Nigeria\. Numbers there look like 0\d{3} \d{3} \d{4}\.$/);
    const long = await request(http).post("/api/v1/customers").set(auth(lagos.token)).send({ name: "Ada Okafor", phone: "0803 123 4567 89" }).expect(400);
    expect(long.body.error.fieldErrors[0].message).toMatch(/too long for Nigeria/);
    const saved = await request(http).post("/api/v1/customers").set(auth(lagos.token)).send({ name: "Ada Okafor", phone: "0803 123 4567" }).expect(201);
    expect(saved.body.data.customer.phoneE164).toBe("+2348031234567");
    // A customer from another country, typed with the country code.
    const ghana = await request(http).post("/api/v1/customers").set(auth(lagos.token)).send({ name: "Kofi Mensah", phone: "+233 24 123 4567" }).expect(201);
    expect(ghana.body.data.customer.phoneE164).toBe("+233241234567");
  });

  it("checks shop phones with the country's rules", async () => {
    const bad = await request(http).patch(`/api/v1/branches/${lagos.branchId}`).set(auth(lagos.token)).send({ phoneE164: "+234803123" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/too short for Nigeria/);
    await request(http).patch(`/api/v1/branches/${lagos.branchId}`).set(auth(lagos.token)).send({ phoneE164: "+2348031234567" }).expect(200);
  });

  it("reads amounts in the business's currency: whole francs in Dakar", async () => {
    const row = { category: "", unit: "bag", cost: "", quantity: "", lowStock: "", barcode: "", packUnit: "", packSize: "", packPrice: "" };
    await request(http)
      .post("/api/v1/imports/products")
      .set(auth(dakar.token))
      .send({ dryRun: false, rows: [{ ...row, name: "Riz brisé 25kg", price: "15,000" }] })
      .expect(200);
    const list = await request(http).get("/api/v1/products").set(auth(dakar.token)).expect(200);
    expect(list.body.data.items[0].priceMinor).toBe("15000");
    const decimals = await request(http)
      .post("/api/v1/imports/products")
      .set(auth(dakar.token))
      .send({ dryRun: true, rows: [{ ...row, name: "Huile", price: "1500.50" }] })
      .expect(200);
    expect(JSON.stringify(decimals.body)).toMatch(/Write it like 1500 or 1,500\./);
  });

  it("adds up the stock: products, in stock, cost and selling value across every page", async () => {
    const add = (name: string, price: string | undefined, quantity: string, cost: string) =>
      request(http)
        .post("/api/v1/products")
        .set(auth(lagos.token))
        .send({ name, baseUnit: "piece", ...(price ? { priceMinor: price } : {}), openingQuantity: quantity, openingCostMinor: cost })
        .expect(201);
    await add("Peak Milk", "45000", "10", "350000");
    await add("Indomie", "25000", "2.5", "50000");
    await add("Sample Bag", undefined, "3", "9000");
    await request(http).post("/api/v1/products").set(auth(lagos.token)).send({ name: "Empty Shelf", baseUnit: "piece", priceMinor: "1000" }).expect(201);
    const list = await request(http).get("/api/v1/products").set(auth(lagos.token)).expect(200);
    expect(list.body.data.totals).toEqual({
      products: 4,
      inStock: 3,
      // 10 × 450.00 + 2.5 × 250.00; the bag has no price.
      sellingValueMinor: String(10n * 45000n + (25000n * 25n) / 10n),
      withoutPrice: 1,
      costValueMinor: String(350000n + 50000n + 9000n),
    });
    const searched = await request(http).get("/api/v1/products?q=milk").set(auth(lagos.token)).expect(200);
    expect(searched.body.data.totals).toMatchObject({ products: 1, inStock: 1, sellingValueMinor: "450000", costValueMinor: "350000" });
  });

  it("writes imported customer names normally and explains bad phones", async () => {
    const preview = await request(http)
      .post("/api/v1/customers/import")
      .set(auth(lagos.token))
      .send({ csv: "name,phone,email,notes\nchika obi,08051234567,,\nNGOZI EZE,0805 123,,", commit: false });
    expect(preview.status).toBeLessThan(300);
    const rows = (preview.body.data.preview ?? preview.body.data.rows) as { name: string; errors: string[] }[];
    expect(rows.map((item) => item.name)).toEqual(["Chika Obi", "Ngozi Eze"]);
    expect(rows[1]?.errors[0]).toMatch(/too short for Nigeria/);
  });
});
