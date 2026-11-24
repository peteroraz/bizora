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

describe("ADR-063: reorder rules and what to buy", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let marketId = "";
  let cementId = "";
  let supplierId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const toBuy = async (token: string, branchId?: string) =>
    (await request(http).get(`/api/v1/stock/to-buy${branchId ? `?branchId=${branchId}` : ""}`).set(auth(token)).expect(200)).body.data.items;
  const rule = (body: Record<string, unknown>, token = owner) => request(http).put(`/api/v1/products/${cementId}/reorder`).set(auth(token)).send(body);

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@reorder.test", password, displayName: "Bola Owner", organizationName: "Bola Building Materials", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bola Building Materials", branchName: "Main" }).expect(200);
    marketId = (await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Market stall", businessId }).expect(201)).body.data.branch.id as string;
    cashier = await invite(http, owner, "cashier@reorder.test", "CASHIER", branchId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@reorder.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
    cementId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Dangote cement", baseUnit: "bag", priceMinor: "1100000", openingQuantity: "3", openingCostMinor: "2850000" }).expect(201)).body.data.product.id as string;
    const received = await request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId: cementId, quantity: "5", unit: "bag", paidFrom: "credit", supplier: "Dangote depot", totalCostMinor: "4750000" }).expect(201);
    expect(received.body.data).toBeTruthy();
    const suppliers = await client.query<{ id: string }>(`SELECT id FROM suppliers WHERE name = 'Dangote depot'`);
    supplierId = suppliers.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("saves the rule for every shop, with the reorder point kept as the low stock level", async () => {
    const saved = (await rule({ reorderPoint: "10", minQuantity: "4", targetQuantity: "40", maxQuantity: "50", leadTimeDays: 3 }).expect(200)).body.data;
    expect(saved.everyShop).toMatchObject({ branchId: null, reorderPoint: "10000", minQuantity: "4000", targetQuantity: "40000", maxQuantity: "50000", leadTimeDays: 3 });
    expect(saved.suppliers).toEqual([{ id: supplierId, name: "Dangote depot", preferred: false, leadTimeDays: null }]);
    const product = (await request(http).get(`/api/v1/products/${cementId}`).set(auth(owner)).expect(200)).body.data.product;
    expect(product.lowStockLevel).toBe("10000");
    expect(product.stock.low).toBe(true);
  });

  it("lists what to buy: how much fills up to the target, from the usual supplier at the last price", async () => {
    const [item] = await toBuy(owner);
    expect(item).toMatchObject({ name: "Dangote cement", onHand: "8000", incoming: "0", reorderPoint: "10000", toOrder: "32000", belowMinimum: false, leadTimeDays: 3, supplierName: "Dangote depot", estimatedCostMinor: "30400000" });
    // Staff without cost see the quantities, not the money.
    const [seen] = await toBuy(cashier);
    expect(seen.toOrder).toBe("32000");
    expect(seen).not.toHaveProperty("estimatedCostMinor");
    const low = (await request(http).get("/api/v1/stock/low").set(auth(owner)).expect(200)).body.data.items;
    expect(low[0]).toMatchObject({ name: "Dangote cement", quantity: "8000", lowStockLevel: "10000" });
  });

  it("lets one shop have its own rule, and refuses rules that do not add up", async () => {
    await rule({ branchId: marketId, reorderPoint: "2", minQuantity: "1", targetQuantity: "6", preferredSupplierId: supplierId }).expect(200);
    const [market] = await toBuy(owner, marketId);
    expect(market).toMatchObject({ onHand: "0", reorderPoint: "2000", toOrder: "6000", belowMinimum: true, supplierName: "Dangote depot", leadTimeDays: 3 });
    expect((await request(http).get(`/api/v1/stock/low?branchId=${marketId}`).set(auth(owner)).expect(200)).body.data.items[0].lowStockLevel).toBe("2000");
    // Main still follows the rule for every shop.
    expect((await toBuy(owner))[0].toOrder).toBe("32000");
    await rule({ reorderPoint: "10", targetQuantity: "10" }).expect(400);
    await rule({ reorderPoint: "10", minQuantity: "12" }).expect(400);
    await rule({ reorderPoint: "10", targetQuantity: "40", maxQuantity: "30" }).expect(400);
    await rule({ reorderPoint: "10", preferredSupplierId: "0192d3e4-0000-7000-8000-000000000000" }).expect(404);
    await rule({ reorderPoint: "1" }, cashier).expect(403);
  });

  it("changes the reorder point for every shop when the low stock level changes, and goes back to it when a shop's rule is removed", async () => {
    await request(http).patch(`/api/v1/products/${cementId}`).set(auth(owner)).send({ name: "Dangote cement", baseUnit: "bag", priceMinor: "1100000", lowStockLevel: "12" }).expect(200);
    expect((await request(http).get(`/api/v1/products/${cementId}/reorder`).set(auth(owner)).expect(200)).body.data.everyShop.reorderPoint).toBe("12000");
    const removed = (await request(http).delete(`/api/v1/products/${cementId}/reorder?branchId=${marketId}`).set(auth(owner)).expect(200)).body.data;
    expect(removed.shops).toEqual([]);
    const [market] = await toBuy(owner, marketId);
    expect(market).toMatchObject({ reorderPoint: "12000", toOrder: "40000", belowMinimum: true });
    await request(http).delete(`/api/v1/products/${cementId}/reorder?branchId=nope`).set(auth(owner)).expect(400);
  });

  it("keeps one business's rules from another", async () => {
    await request(http).get(`/api/v1/products/${cementId}/reorder`).set(auth(other)).expect(404);
    await request(http).put(`/api/v1/products/${cementId}/reorder`).set(auth(other)).send({ reorderPoint: "1" }).expect(404);
    expect(await toBuy(other)).toEqual([]);
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
