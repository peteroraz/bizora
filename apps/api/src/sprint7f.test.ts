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


describe("sprint 7f: default shops, closing shops, reasons on stock, customer address on documents", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let organizationId = "";
  let businessId = "";
  let mainId = "";
  let marketId = "";
  let productId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const login = async (email: string) => (await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201)).body.data;
  const inShop = async (token: string, branchId: string) => {
    // Switching shop replaces the session: the new token is the one to use from here.
    const response = await request(http).post("/api/v1/auth/select-context").set(auth(token)).send({ organizationId, businessId, branchId }).expect(201);
    return response.body.data.accessToken as string;
  };
  const stockIn = async (token: string) => {
    const product = await request(http).get(`/api/v1/products/${productId}`).set(auth(token)).expect(200);
    return product.body.data.product.stock?.quantity ?? product.body.data.product.quantity;
  };

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "owner@shops.test",
        password,
        displayName: "Uche Owner",
        organizationName: "Uche Electronics",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    organizationId = registered.body.data.tenant.tenantId as string;
    businessId = registered.body.data.tenant.businessId as string;
    mainId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Uche Electronics", branchName: "Main" })
      .expect(200);
    const market = await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Market stall", businessId }).expect(201);
    marketId = market.body.data.branch.id as string;
    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(owner))
      .send({ name: "Phone charger", baseUnit: "piece", priceMinor: "300000", defaultCostMinor: "200000", openingQuantity: "10", openingCostMinor: "2000000" })
      .expect(201);
    productId = product.body.data.product.id as string;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("opens each person's Bizora in their default shop", async () => {
    // A manager for the whole business opens in "all shops" until a default is set.
    const invited = await request(http).post("/api/v1/invitations").set(auth(owner)).send({ email: "manager@shops.test", role: "MANAGER", businessId }).expect(201);
    await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: "Ada Manager", password }).expect(201);
    const before = await login("manager@shops.test");
    expect(before.tenant.branchId).toBeNull();
    const people = await request(http).get("/api/v1/memberships").set(auth(owner)).expect(200);
    const managerId = people.body.data.items.find((person: { email: string }) => person.email === "manager@shops.test").membershipId as string;
    // Only the person, or those who manage people, may set it.
    const cashier = await invite(http, owner, "cashier@shops.test", "CASHIER", mainId, businessId);
    await request(http).put(`/api/v1/memberships/${managerId}/default-shop`).set(auth(cashier)).send({ branchId: marketId }).expect(403);
    await request(http).put(`/api/v1/memberships/${managerId}/default-shop`).set(auth(owner)).send({ branchId: marketId }).expect(200);
    const after = await login("manager@shops.test");
    expect(after.tenant.branchId).toBe(marketId);
    // Choosing "all shops" afterwards still works.
    const all = await request(http).post("/api/v1/auth/select-context").set(auth(after.accessToken)).send({ organizationId, businessId }).expect(201);
    expect(all.body.data.tenant.branchId).toBeNull();
    // Someone tied to one shop always opens there.
    const cashierId = (await request(http).get("/api/v1/memberships").set(auth(owner)).expect(200)).body.data.items.find((person: { email: string }) => person.email === "cashier@shops.test").membershipId;
    await request(http).put(`/api/v1/memberships/${cashierId}/default-shop`).set(auth(owner)).send({ branchId: marketId }).expect(400);
    // The owner sets their own.
    const me = (await request(http).get("/api/v1/auth/me").set(auth(owner)).expect(200)).body.data.tenant.membershipId as string;
    await request(http).put(`/api/v1/memberships/${me}/default-shop`).set(auth(owner)).send({ branchId: mainId }).expect(200);
    expect((await login("owner@shops.test")).tenant.branchId).toBe(mainId);
  });

  it("asks why when stock is adjusted, a price changes or a count is rejected, and shows it in the history", async () => {
    await request(http).post("/api/v1/stock/adjust").set(auth(owner)).send({ productId, direction: "remove", reason: "damaged", quantity: "1", unit: "piece" }).expect(400);
    await request(http).post("/api/v1/stock/adjust").set(auth(owner)).send({ productId, direction: "remove", reason: "damaged", quantity: "1", unit: "piece", note: "Dropped in water" }).expect(201);
    const movements = await request(http).get(`/api/v1/products/${productId}/movements`).set(auth(owner)).expect(200);
    expect(movements.body.data.items[0]).toMatchObject({ type: "adjusted", reason: "damaged", note: "Dropped in water" });

    // A new selling price says why.
    const body = { name: "Phone charger", baseUnit: "piece", priceMinor: "350000", defaultCostMinor: "200000" };
    expect((await request(http).patch(`/api/v1/products/${productId}`).set(auth(owner)).send(body).expect(400)).body.error.code).toBe("REASON_REQUIRED");
    await request(http).patch(`/api/v1/products/${productId}`).set(auth(owner)).send({ ...body, changeReason: "Supplier raised prices" }).expect(200);
    await request(http).patch(`/api/v1/products/${productId}`).set(auth(owner)).send({ ...body, defaultCostMinor: "250000", changeReason: "New supplier" }).expect(200);

    // A store keeper's count waits; rejecting it needs a reason.
    const keeper = await invite(http, owner, "store@shops.test", "INVENTORY", mainId, businessId);
    const counted = await request(http).post("/api/v1/stock/counts").set(auth(keeper)).send({ productId, countedQuantity: "5", unit: "piece", note: "Front shelf only" }).expect(201);
    const countId = counted.body.data.count.id as string;
    await request(http).post(`/api/v1/stock/counts/${countId}/reject`).set(auth(owner)).send({}).expect(400);
    const rejected = await request(http).post(`/api/v1/stock/counts/${countId}/reject`).set(auth(owner)).send({ note: "Count the back store too" }).expect(200);
    expect(rejected.body.data.count).toMatchObject({ status: "rejected", decisionNote: "Count the back store too" });
    // An approved count keeps both notes on the movement.
    const second = await request(http).post("/api/v1/stock/counts").set(auth(keeper)).send({ productId, countedQuantity: "8", unit: "piece", note: "Front and back" }).expect(201);
    await request(http).post(`/api/v1/stock/counts/${second.body.data.count.id}/approve`).set(auth(owner)).send({ note: "Checked with Ada" }).expect(200);
    const afterCount = await request(http).get(`/api/v1/products/${productId}/movements`).set(auth(owner)).expect(200);
    expect(afterCount.body.data.items[0]).toMatchObject({ type: "counted", note: "Front and back · Checked with Ada" });

    const changes = await request(http).get(`/api/v1/products/${productId}/changes`).set(auth(owner)).expect(200);
    expect(changes.body.data.items.map((item: { action: string }) => item.action)).toEqual(["stock.count_rejected", "product.updated", "product.updated"]);
    expect(changes.body.data.items[0]).toMatchObject({ reason: "Count the back store too", countedQuantity: "5000", byName: "Uche Owner" });
    expect(changes.body.data.items[1]).toMatchObject({ reason: "New supplier", changes: { cost: ["200000", "250000"] } });
    expect(changes.body.data.items[2]).toMatchObject({ reason: "Supplier raised prices", changes: { price: ["300000", "350000"] } });
    // Someone who may not see cost does not see cost changes.
    const keeperView = await request(http).get(`/api/v1/products/${productId}/changes`).set(auth(keeper)).expect(200);
    expect(keeperView.body.data.items.map((item: { action: string }) => item.action)).toEqual(["stock.count_rejected", "product.updated"]);
    // The audit trail carries the reasons too.
    const audit = await client.query<{ action: string; metadata_json: string }>("SELECT action, metadata_json FROM audit_events WHERE action = 'stock.adjusted'");
    expect(JSON.parse(audit.rows[0]?.metadata_json ?? "{}")).toMatchObject({ reason: "damaged", note: "Dropped in water" });
  });

  it("prints the customer's address on the invoice and the receipt link", async () => {
    const customer = await request(http)
      .post("/api/v1/customers")
      .set(auth(owner))
      .send({ name: "Koko Buka", phone: "08031234567", address: { shopNumber: "C4", marketOrPlaza: "Alaba Market", city: "Lagos", countryCode: "NG", subdivisionCode: "NG-LA" } })
      .expect(201);
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId, quantity: "1", unit: "piece" }], customerId: customer.body.data.customer.id, payments: [{ method: "cash", amountMinor: "350000" }] })
      .expect(201);
    const full = await request(http).get(`/api/v1/sales/${sale.body.data.sale.id}`).set(auth(owner)).expect(200);
    const token = (full.body.data.sale.receiptPath as string).split("/").pop();
    const receipt = await request(http).get(`/api/v1/public/receipts/${token}`).expect(200);
    expect(receipt.body.data.receipt).toMatchObject({ customerName: "Koko Buka", customerAddress: "Shop C4, Alaba Market, Lagos" });
    const pdf = await request(http).get(`/api/v1/sales/${sale.body.data.sale.id}/documents/receipt.pdf`).set(auth(owner)).buffer(true).expect(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
  });

  it("lets only the owner close a shop, moving its stock, cash, staff and customers into another", async () => {
    // Stock, cash and a shop-bound cashier at the market stall.
    owner = await inShop(owner, marketId);
    const ownerAtMarket = owner;
    await request(http).post("/api/v1/stock/receive").set(auth(ownerAtMarket)).send({ productId, quantity: "4", unit: "piece", totalCostMinor: "1000000", paidFrom: "credit", supplier: "Ali Wholesale" }).expect(201);
    await request(http).post("/api/v1/sales").set(auth(ownerAtMarket)).send({ lines: [{ productId, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "350000" }] }).expect(201);
    const stallCashier = await invite(http, owner, "stall@shops.test", "CASHIER", marketId, businessId);
    const admin = await invite(http, owner, "admin@shops.test", "ADMINISTRATOR", mainId, businessId);
    owner = await inShop(owner, mainId);
    const mainStockBefore = BigInt(await stockIn(owner));

    await request(http).post(`/api/v1/branches/${marketId}/close`).set(auth(admin)).send({ reason: "Lease ended", moveToBranchId: mainId }).expect(403);
    const check = await request(http).get(`/api/v1/branches/${marketId}/closing`).set(auth(owner)).expect(200);
    expect(check.body.data).toMatchObject({ productsInStock: 1, cashMinor: "350000", staff: 1, openSales: 0, belowZero: 0 });
    expect((await request(http).post(`/api/v1/branches/${marketId}/close`).set(auth(owner)).send({ reason: "Lease ended" }).expect(400)).body.error.code).toBe("CHOOSE_SHOP");

    const closed = await request(http).post(`/api/v1/branches/${marketId}/close`).set(auth(owner)).send({ reason: "Lease ended", moveToBranchId: mainId }).expect(200);
    expect(closed.body.data).toMatchObject({ movedInto: { id: mainId }, moved: { products: 1, cashMinor: "350000", staff: 1 } });
    // The stock and the cash are now in the main shop.
    const ownerAtMain = owner;
    expect(BigInt(await stockIn(ownerAtMain)) - mainStockBefore).toBe(3000n);
    const cash = await request(http).get("/api/v1/money/cash").set(auth(ownerAtMain)).expect(200);
    expect(cash.body.data.shops.map((shop: { name: string }) => shop.name)).toEqual(["Main"]);
    // The stall cashier signs in again and works in the main shop.
    await request(http).get("/api/v1/auth/me").set(auth(stallCashier)).expect(401);
    expect((await login("stall@shops.test")).tenant.branchId).toBe(mainId);
    // The closed shop is not listed and takes no new work, but its history stays.
    const shops = await request(http).get("/api/v1/branches").set(auth(owner)).expect(200);
    expect(shops.body.data.items.map((shop: { id: string }) => shop.id)).toEqual([mainId]);
    await request(http).post("/api/v1/stock/transfer").set(auth(ownerAtMain)).send({ productId, toBranchId: marketId, quantity: "1", unit: "piece" }).expect(409);
    await request(http).post(`/api/v1/branches/${marketId}/close`).set(auth(owner)).send({ reason: "Again", moveToBranchId: mainId }).expect(409);
    // The manager whose default was the stall now opens in the main shop.
    expect((await login("manager@shops.test")).tenant.branchId).toBe(mainId);
    // The last open shop cannot be closed, and the books still balance.
    expect((await request(http).post(`/api/v1/branches/${mainId}/close`).set(auth(owner)).send({ reason: "Done" }).expect(409)).body.error.code).toBe("LAST_SHOP");
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
