import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
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
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

describe("ADR-041: what staff can sell, and typed items remembered", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let businessId = "";
  let riceId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sell = (token: string, lines: unknown[], total: string) =>
    request(http).post("/api/v1/sales").set(auth(token)).send({ lines, payments: [{ method: "cash", amountMinor: total }] });
  const saved = async (token: string) => (await request(http).get("/api/v1/saved-items").set(auth(token)).expect(200)).body.data;
  const credits = async (saleId: string) =>
    (
      await client.query<{ role: string; credit: string }>(
        "SELECT a.role, jl.credit_minor::text AS credit FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_id = $1 AND jl.credit_minor > 0 ORDER BY a.role",
        [saleId],
      )
    ).rows;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@typed.test", password, displayName: "Kemi Owner", organizationName: "Kemi Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Kemi Stores", branchName: "Main" })
      .expect(200);
    cashier = await invite(http, owner, "cashier@typed.test", "CASHIER", branchId, businessId);
    riceId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", openingQuantity: "10", openingCostMinor: "60000000" }).expect(201)).body.data.product.id as string;
    other = (
      await request(http)
        .post("/api/v1/auth/register")
        .send({ email: "other@typed.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true })
        .expect(201)
    ).body.data.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("sells only products from the list until the owner allows typed items; services still work", async () => {
    expect((await saved(cashier)).salesItems).toBe("products");
    const refused = await sell(cashier, [{ description: "Agege bread", quantity: "3", unitPriceMinor: "150000", saved: true }], "450000").expect(403);
    expect(refused.body.error.code).toBe("TYPED_ITEMS_OFF");
    // A service line from the API, as before (ADR-035), is not a typed item.
    await sell(cashier, [{ description: "Delivery", unitPriceMinor: "50000" }], "50000").expect(201);
    // Only someone who manages the business settings changes it.
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(cashier)).send({ salesItems: "both" }).expect(403);
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ salesItems: "sometimes" }).expect(400);
    const changed = await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ salesItems: "both" }).expect(200);
    expect(changed.body.data.business.salesItems).toBe("both");
  });

  it("records a typed item with a product, counts it as sales, leaves stock alone and remembers it", async () => {
    const sold = await sell(
      cashier,
      [
        { productId: riceId, quantity: "1", unit: "bag" },
        { description: "Agege  bread", quantity: "3", unit: "piece", unitPriceMinor: "150000", saved: true },
      ],
      "7950000",
    ).expect(201);
    const sale = sold.body.data.sale;
    expect(sale.totalMinor).toBe("7950000");
    expect(sale.lines.map((line: { description: string }) => line.description)).toEqual(["Rice 50kg", "Agege bread"]);
    // Typed items are goods: sales income, not service income. Only the rice leaves stock.
    expect(await credits(sale.id)).toEqual([{ role: "sales", credit: "7950000" }]);
    const rice = (await request(http).get(`/api/v1/products/${riceId}`).set(auth(owner)).expect(200)).body.data.product;
    expect(rice.stock.quantity).toBe("9000");
    const list = await saved(cashier);
    expect(list.items).toEqual([expect.objectContaining({ name: "Agege bread", unit: "piece", lastPriceMinor: "150000", timesSold: 1 })]);
  });

  it("keeps one saved item however it is typed, with the latest price and unit", async () => {
    await sell(cashier, [{ description: "agege BREAD", quantity: "2", unit: "pack", unitPriceMinor: "160000", saved: true }], "320000").expect(201);
    const list = await saved(cashier);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: "Agege bread", unit: "pack", lastPriceMinor: "160000", timesSold: 2 });
    // Free needs a manager, as for products.
    await sell(cashier, [{ description: "Agege bread", quantity: "1", unitPriceMinor: "0", saved: true }], "0").expect(403);
  });

  it("keeps a typed item sold offline even after the shop went back to products only, and remembers it", async () => {
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ salesItems: "products" }).expect(200);
    const id = uuidv7();
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(cashier))
      .send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id, lines: [{ description: "Pure water", quantity: "20", unit: "sachet", unitPriceMinor: "5000", saved: true }], payments: [{ method: "cash", amountMinor: "100000" }], soldAt: new Date().toISOString() } }] })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    expect((await saved(cashier)).items.map((item: { name: string }) => item.name)).toContain("Pure water");
    // Online, the counter now refuses typed items again.
    await sell(cashier, [{ description: "Pure water", quantity: "1", unitPriceMinor: "5000", saved: true }], "5000").expect(403);
  });

  it("lets the owner remove a saved item; staff cannot; other businesses never see them", async () => {
    const list = await saved(owner);
    const water = list.items.find((item: { name: string }) => item.name === "Pure water");
    await request(http).delete(`/api/v1/saved-items/${water.id}`).set(auth(cashier)).expect(403);
    await request(http).delete(`/api/v1/saved-items/${water.id}`).set(auth(other)).expect(404);
    expect((await saved(other)).items).toEqual([]);
    await request(http).delete(`/api/v1/saved-items/${water.id}`).set(auth(owner)).expect(200);
    expect((await saved(owner)).items.map((item: { name: string }) => item.name)).not.toContain("Pure water");
    await request(http).delete(`/api/v1/saved-items/${water.id}`).set(auth(owner)).expect(404);
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
