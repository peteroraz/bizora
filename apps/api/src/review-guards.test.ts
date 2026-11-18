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
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";


describe("review 19 Nov: stock never goes below zero by what is done here and now", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let sales = "";
  let businessId = "";
  let branchId = "";
  let bagId = "";
  let openId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const onHand = async () => (await request(http).get(`/api/v1/products/${bagId}`).set(auth(owner)).expect(200)).body.data.product.stock.quantity as string;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@guards.test", password, displayName: "Bisi Owner", organizationName: "Bisi Grains", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Grains", branchName: "Main" })
      .expect(200);
    sales = await invite(http, owner, "sales@guards.test", "SALES", branchId, businessId);
    // One bag of rice on the shelf.
    const bag = await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", openingQuantity: "1", openingCostMinor: "6000000" }).expect(201);
    bagId = bag.body.data.product.id as string;
    const open = await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Garri (open price)", baseUnit: "piece", trackStock: false }).expect(201);
    openId = open.body.data.product.id as string;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("refuses to sell 2 bags when 1 is on the shelf, and says how many are left", async () => {
    const refused = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: bagId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "15000000" }] })
      .expect(422);
    expect(refused.body.error).toMatchObject({ code: "NOT_ENOUGH_STOCK", message: "Not enough Rice 50kg in Main: 1 bag left, 2 bags needed. Record the stock that came in first, or count it." });
    // The same product on two lines counts together.
    await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: bagId, quantity: "1", unit: "bag" }, { productId: bagId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "15000000" }] })
      .expect(422);
    expect(await onHand()).toBe("1000");
    // Removing or moving more than is there is refused too.
    await request(http).post("/api/v1/stock/adjust").set(auth(owner)).send({ productId: bagId, direction: "remove", reason: "damaged", quantity: "2", unit: "bag", note: "Wet" }).expect(422);
    // One bag sells; the shelf is then empty, never negative.
    await request(http).post("/api/v1/sales").set(auth(owner)).send({ lines: [{ productId: bagId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] }).expect(201);
    expect(await onHand()).toBe("0");
    await request(http).post("/api/v1/sales").set(auth(owner)).send({ lines: [{ productId: bagId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] }).expect(422);
  });

  it("checks the shelf before the cashier takes money in the sales-desk flow", async () => {
    await request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId: bagId, quantity: "1", unit: "bag", totalCostMinor: "6000000", paidFrom: "cash" }).expect(201);
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ salesFlow: "desk" }).expect(200);
    await request(http).post("/api/v1/sales").set(auth(sales)).send({ lines: [{ productId: bagId, quantity: "2", unit: "bag" }], payments: [] }).expect(422);
    const first = await request(http).post("/api/v1/sales").set(auth(sales)).send({ lines: [{ productId: bagId, quantity: "1", unit: "bag" }], payments: [] }).expect(201);
    const second = await request(http).post("/api/v1/sales").set(auth(sales)).send({ lines: [{ productId: bagId, quantity: "1", unit: "bag" }], payments: [] }).expect(201);
    // Both invoices wait; the first to be released takes the bag, the second cannot be paid for.
    await request(http).post(`/api/v1/sales/${first.body.data.sale.id}/collect`).set(auth(owner)).send({ payments: [{ method: "cash", amountMinor: "7500000" }] }).expect(200);
    await request(http).post(`/api/v1/sales/${first.body.data.sale.id}/release`).set(auth(owner)).send({}).expect(200);
    const blocked = await request(http).post(`/api/v1/sales/${second.body.data.sale.id}/collect`).set(auth(owner)).send({ payments: [{ method: "cash", amountMinor: "7500000" }] }).expect(422);
    expect(blocked.body.error.code).toBe("NOT_ENOUGH_STOCK");
    expect(await onHand()).toBe("0");
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ salesFlow: "simple" }).expect(200);
  });

  it("needs a manager to give something away free", async () => {
    const free = await request(http).post("/api/v1/sales").set(auth(sales)).send({ lines: [{ productId: openId, quantity: "1", unit: "piece", unitPriceMinor: "0" }], payments: [] }).expect(403);
    expect(free.body.error.message).toBe("Ask a manager to give Garri (open price) away free.");
    await request(http).post("/api/v1/sales").set(auth(sales)).send({ lines: [{ productId: openId, quantity: "1", unit: "piece", unitPriceMinor: "120000" }], payments: [{ method: "cash", amountMinor: "120000" }] }).expect(201);
    const trial = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    expect(trial.body.data.balanced).toBe(true);
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
