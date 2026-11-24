import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@bizora/contracts";
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

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("ADR-061: batches and expiry dates", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let businessId = "";
  let mainId = "";
  let marketId = "";
  let drugId = "";
  let plainId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const batches = async (token: string, productId: string, branchId?: string) =>
    (await request(http).get(`/api/v1/products/${productId}/batches${branchId ? `?branchId=${branchId}` : ""}`).set(auth(token)).expect(200)).body.data;
  const receive = (productId: string, quantity: string, batch?: Record<string, string>) =>
    request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId, quantity, unit: "pack", totalCostMinor: (BigInt(quantity) * 100000n).toString(), paidFrom: "cash", ...(batch ? { batch } : {}) });

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@batch.test", password, displayName: "Ngozi Owner", organizationName: "Ngozi Pharmacy", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    mainId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ngozi Pharmacy", branchName: "Main" }).expect(200);
    marketId = (await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Market stall", businessId }).expect(201)).body.data.branch.id as string;
    cashier = await invite(http, owner, "cashier@batch.test", "CASHIER", mainId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@batch.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
    drugId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Paracetamol 500mg", baseUnit: "pack", priceMinor: "150000", tracksBatches: true }).expect(201)).body.data.product.id as string;
    plainId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Plastic bag", baseUnit: "pack", priceMinor: "5000" }).expect(201)).body.data.product.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("keeps each delivery in its batch, and adds the same batch together", async () => {
    await receive(drugId, "4", { batchNumber: "PX-OLD", expiryDate: day(-5) }).expect(201);
    await receive(drugId, "5", { batchNumber: "PX-SOON", expiryDate: day(10), manufacturedDate: day(-300) }).expect(201);
    await receive(drugId, "6", { batchNumber: "PX-LATE", expiryDate: day(200) }).expect(201);
    await receive(drugId, "1", { batchNumber: "PX-SOON", expiryDate: day(10) }).expect(201);
    const list = await batches(owner, drugId);
    expect(list.tracksBatches).toBe(true);
    expect(list.items.map((batch: { batchNumber: string; quantity: string; status: string }) => [batch.batchNumber, batch.quantity, batch.status])).toEqual([
      ["PX-OLD", "4000", "expired"],
      ["PX-SOON", "6000", "soon"],
      ["PX-LATE", "6000", "ok"],
    ]);
    expect(list.items[1].manufacturedDate).toBe(day(-300));
    // A product that does not keep batches has none, and nothing changes for it.
    await receive(plainId, "3", { batchNumber: "IGNORED" }).expect(201);
    expect((await batches(owner, plainId)).items).toEqual([]);
  });

  it("sells what is within date first, earliest expiry first, and remembers the batch", async () => {
    await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: drugId, quantity: "7", unit: "pack" }], payments: [{ method: "cash", amountMinor: "1050000" }] }).expect(201);
    const list = await batches(owner, drugId);
    expect(list.items.map((batch: { batchNumber: string; quantity: string }) => [batch.batchNumber, batch.quantity])).toEqual([
      ["PX-OLD", "4000"],
      ["PX-LATE", "5000"],
    ]);
    const used = await client.query<{ batch_number: string; quantity: string }>(
      `SELECT b.batch_number, mb.quantity::text AS quantity FROM stock_movement_batches mb JOIN stock_batches b ON b.id = mb.batch_id
       JOIN stock_movements m ON m.id = mb.movement_id WHERE m.movement_type = 'sold' ORDER BY b.expiry_date`,
    );
    expect(used.rows).toEqual([
      { batch_number: "PX-SOON", quantity: "-6000" },
      { batch_number: "PX-LATE", quantity: "-1000" },
    ]);
  });

  it("refuses a sale at the counter that would need expired stock, and keeps an offline sale that already happened", async () => {
    const refused = await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: drugId, quantity: "6", unit: "pack" }], payments: [{ method: "cash", amountMinor: "900000" }] }).expect(422);
    expect(refused.body.error.code).toBe("EXPIRED_STOCK");
    expect(refused.body.error.message).toContain("Remove the expired stock first");
    const offline = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), provisionalNumber: "DEV9-000001", soldAt: new Date(Date.now() - 600_000).toISOString(), lines: [{ productId: drugId, quantity: "6", unit: "pack" }], payments: [{ method: "cash", amountMinor: "900000" }] } };
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [offline] }).expect(200);
    expect(pushed.body.data.results[0].status).not.toBe("rejected");
    const list = await batches(owner, drugId);
    // Within date first (5 from PX-LATE), then 1 from the expired batch.
    expect(list.items.map((batch: { batchNumber: string; quantity: string }) => [batch.batchNumber, batch.quantity])).toEqual([["PX-OLD", "3000"]]);
  });

  it("takes expired stock off by batch, and lists what is expiring", async () => {
    await receive(drugId, "2", { batchNumber: "PX-NEW", expiryDate: day(20) }).expect(201);
    const expiring = (await request(http).get("/api/v1/stock/expiring").set(auth(owner)).expect(200)).body.data;
    expect(expiring.expired).toBe(1);
    expect(expiring.soon).toBe(1);
    expect(expiring.items.map((batch: { batchNumber: string; daysLeft: number }) => batch.batchNumber)).toEqual(["PX-OLD", "PX-NEW"]);
    expect(expiring.items[0].daysLeft).toBeLessThan(0);
    expect((await request(http).get("/api/v1/stock/expiring?days=5").set(auth(owner)).expect(200)).body.data.items).toHaveLength(1);
    await request(http).get("/api/v1/stock/expiring?days=-1").set(auth(owner)).expect(400);
    const old = expiring.items[0].id as string;
    await request(http).post("/api/v1/stock/adjust").set(auth(owner)).send({ productId: drugId, direction: "remove", reason: "expired", quantity: "4", unit: "pack", note: "Past date", batchId: old }).expect(422);
    await request(http).post("/api/v1/stock/adjust").set(auth(owner)).send({ productId: drugId, direction: "remove", reason: "expired", quantity: "3", unit: "pack", note: "Past date", batchId: old }).expect(201);
    expect((await batches(owner, drugId)).items.map((batch: { batchNumber: string }) => batch.batchNumber)).toEqual(["PX-NEW"]);
  });

  it("moves batches with stock sent to another shop", async () => {
    await request(http).post("/api/v1/stock/transfer").set(auth(owner)).send({ productId: drugId, fromBranchId: mainId, toBranchId: marketId, quantity: "1", unit: "pack" }).expect(201);
    const there = await batches(owner, drugId, marketId);
    expect(there.items.map((batch: { batchNumber: string; expiryDate: string; quantity: string }) => [batch.batchNumber, batch.expiryDate, batch.quantity])).toEqual([["PX-NEW", day(20), "1000"]]);
    expect((await batches(owner, drugId)).items[0].quantity).toBe("1000");
  });

  it("can be switched on for a product, and only by someone who manages products", async () => {
    await request(http).patch(`/api/v1/products/${plainId}`).set(auth(cashier)).send({ name: "Plastic bag", baseUnit: "pack", tracksBatches: true }).expect(403);
    const changed = await request(http).patch(`/api/v1/products/${plainId}`).set(auth(owner)).send({ name: "Plastic bag", baseUnit: "pack", priceMinor: "5000", tracksBatches: true }).expect(200);
    expect(changed.body.data.product.tracksBatches).toBe(true);
    // Stock from before batches were kept still sells: it is in no batch.
    await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: plainId, quantity: "2", unit: "pack" }], payments: [{ method: "cash", amountMinor: "10000" }] }).expect(201);
  });

  it("keeps one business's batches from another", async () => {
    await request(http).get(`/api/v1/products/${drugId}/batches`).set(auth(other)).expect(404);
    const theirs = (await request(http).get("/api/v1/stock/expiring?days=365").set(auth(other)).expect(200)).body.data;
    expect(theirs.items).toEqual([]);
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
