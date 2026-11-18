import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { LedgerPostingService } from "./modules/ledger/ledger-posting.service.js";
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

async function registerOwner(http: Http, label: string, industryCode = "general-retail") {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@offline.test`,
      password,
      displayName: `Owner ${label}`,
      organizationName: `Shop ${label}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode,
    })
    .expect(201);
  const token = owner.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({
      countryCode: "NG",
      industryCode,
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
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

describe("products and stock", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let salesToken = "";
  let storekeeperToken = "";
  let managerToken = "";
  let riceId = "";
  let secondShopId = "";
  let offlineReceiveId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    ledger = app.get(LedgerPostingService);
    salesToken = await invite(http, a.token, "sales@stock.test", "SALES", a.branchId, a.businessId);
    storekeeperToken = await invite(http, a.token, "store@stock.test", "INVENTORY", a.branchId, a.businessId);
    managerToken = await invite(http, a.token, "manager@stock.test", "MANAGER", a.branchId, a.businessId);
    const second = await request(http).post("/api/v1/branches").set(auth(a.token)).send({ name: "Second shop" }).expect(201);
    secondShopId = second.body.data.branch.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("creates a product with packs and opening stock, posted against the owner's money", async () => {
    const http = app.getHttpServer();
    const created = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({
        id: uuidv7(),
        name: "Rice 50kg",
        category: "Grains",
        baseUnit: "bag",
        priceMinor: "8500000",
        lowStockLevel: "5",
        openingQuantity: "10",
        openingCostMinor: "75000000",
      })
      .expect(201);
    const rice = created.body.data.product;
    riceId = rice.id;
    expect(rice.stock).toMatchObject({ quantity: "10000", valueMinor: "75000000", low: false });
    expect(rice.defaultCostMinor).toBeNull();

    const noodles = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({ name: "Indomie 70g", baseUnit: "piece", priceMinor: "25000", packs: [{ unitCode: "carton", baseQuantity: "40", priceMinor: "950000" }] })
      .expect(201);
    expect(noodles.body.data.product.packs).toEqual([{ unitCode: "carton", baseQuantity: "40000", priceMinor: "950000" }]);

    const duplicate = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "rice 50KG", baseUnit: "bag" }).expect(409);
    expect(duplicate.body.error.code).toBe("DUPLICATE_PRODUCT");

    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1300")).toBe(750_000_00n);
    expect(balance(trial.accounts, "3000")).toBe(-750_000_00n);
  });

  it("receives stock at weighted-average cost and credits cash, bank or the supplier", async () => {
    const http = app.getHttpServer();
    const received = await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(a.token))
      .send({ productId: riceId, quantity: "10", unit: "bag", totalCostMinor: "80000000", paidFrom: "cash", supplier: "Dangote Distributors" })
      .expect(201);
    expect(received.body.data).toMatchObject({ documentNumber: "SI-000002", onHand: "20000", valueMinor: "80000000" });

    // Average is now ₦77,500 a bag; removing 2 damaged bags costs ₦155,000.
    const removed = await request(http)
      .post("/api/v1/stock/adjust")
      .set(auth(a.token))
      .send({ productId: riceId, direction: "remove", reason: "damaged", quantity: "2", unit: "bag", note: "Rain" })
      .expect(201);
    expect(removed.body.data).toMatchObject({ onHand: "18000", valueMinor: "-15500000" });

    const ownUse = await request(http)
      .post("/api/v1/stock/adjust")
      .set(auth(a.token))
      .send({ productId: riceId, direction: "remove", reason: "own_use", quantity: "1", unit: "bag", note: "For the house" })
      .expect(201);
    expect(ownUse.body.data.valueMinor).toBe("-7750000");

    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1000-01")).toBe(-800_000_00n);
    expect(balance(trial.accounts, "5100")).toBe(155_000_00n);
    expect(balance(trial.accounts, "3100")).toBe(77_500_00n);
    expect(balance(trial.accounts, "1300")).toBe(750_000_00n + 800_000_00n - 155_000_00n - 77_500_00n);
  });

  it("converts packs to the base unit", async () => {
    const http = app.getHttpServer();
    const list = await request(http).get("/api/v1/products").query({ q: "indomie" }).set(auth(a.token)).expect(200);
    const noodles = list.body.data.items[0];
    const received = await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(a.token))
      .send({ productId: noodles.id, quantity: "3", unit: "carton", totalCostMinor: "2400000", paidFrom: "bank" })
      .expect(201);
    expect(received.body.data.onHand).toBe("120000");
    const wrongUnit = await request(http).post("/api/v1/stock/receive").set(auth(a.token)).send({ productId: noodles.id, quantity: "3", unit: "kg" }).expect(422);
    expect(wrongUnit.body.error.code).toBe("UNIT_NOT_FOUND");
  });

  it("moves stock between shops at cost, without touching the accounts", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const moved = await request(http)
      .post("/api/v1/stock/transfer")
      .set(auth(a.token))
      .send({ productId: riceId, toBranchId: secondShopId, quantity: "4", unit: "bag" })
      .expect(201);
    expect(moved.body.data).toMatchObject({ documentNumber: "TR-000001", onHand: "13000", valueMinor: "-31000000" });
    const product = await request(http).get(`/api/v1/products/${riceId}`).set(auth(a.token)).expect(200);
    const shops = product.body.data.product.shops as { branchId: string; quantity: string; valueMinor: string }[];
    expect(shops.find((shop) => shop.branchId === secondShopId)).toMatchObject({ quantity: "4000", valueMinor: "31000000" });
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.totalDebitMinor).toBe(before.totalDebitMinor);
    await request(http).post("/api/v1/stock/transfer").set(auth(a.token)).send({ productId: riceId, toBranchId: a.branchId, quantity: "1", unit: "bag" }).expect(422);
  });

  it("hides cost from sales staff and lets only the right roles change stock", async () => {
    const http = app.getHttpServer();
    const sales = await request(http).get(`/api/v1/products/${riceId}`).set(auth(salesToken)).expect(200);
    expect(sales.body.data.product.priceMinor).toBe("8500000");
    expect(sales.body.data.product).not.toHaveProperty("defaultCostMinor");
    expect(sales.body.data.product.stock).not.toHaveProperty("valueMinor");
    const movements = await request(http).get(`/api/v1/products/${riceId}/movements`).set(auth(salesToken)).expect(200);
    expect(movements.body.data.items[0]).not.toHaveProperty("valueMinor");
    expect(movements.body.data.items.map((item: { byName: string }) => item.byName)).toContain("Owner a");

    await request(http).post("/api/v1/stock/receive").set(auth(salesToken)).send({ productId: riceId, quantity: "1", unit: "bag" }).expect(403);
    await request(http).post("/api/v1/products").set(auth(salesToken)).send({ name: "Sneaky", baseUnit: "piece" }).expect(403);
    await request(http).post("/api/v1/stock/adjust").set(auth(storekeeperToken)).send({ productId: riceId, direction: "remove", reason: "missing", quantity: "1", unit: "bag", note: "Cannot find it" }).expect(403);

    // The storekeeper receives goods owed to the supplier, but cannot record paying cash.
    const paid = await request(http).post("/api/v1/stock/receive").set(auth(storekeeperToken)).send({ productId: riceId, quantity: "1", unit: "bag", paidFrom: "cash" }).expect(403);
    expect(paid.body.error.fieldErrors[0].field).toBe("paidFrom");
    const owed = await request(http).post("/api/v1/stock/receive").set(auth(storekeeperToken)).send({ productId: riceId, quantity: "2", unit: "bag" }).expect(201);
    expect(owed.body.data).not.toHaveProperty("valueMinor");
    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(balance(trial.accounts, "2000")).toBe(-155_000_00n);
  });

  it("holds a storekeeper's count for a manager, and applies the difference found when counting", async () => {
    const http = app.getHttpServer();
    const counted = await request(http).post("/api/v1/stock/counts").set(auth(storekeeperToken)).send({ productId: riceId, countedQuantity: "12", unit: "bag" }).expect(201);
    expect(counted.body.data.count).toMatchObject({ status: "pending", systemQuantity: "15000", difference: "-3000" });
    const pending = await request(http).get("/api/v1/stock/counts").set(auth(managerToken)).expect(200);
    expect(pending.body.data.items).toHaveLength(1);
    expect(pending.body.data.items[0]).toMatchObject({ productName: "Rice 50kg", countedByName: "store@stock.test" });
    await request(http).get("/api/v1/stock/counts").set(auth(storekeeperToken)).expect(403);

    const approved = await request(http).post(`/api/v1/stock/counts/${counted.body.data.count.id}/approve`).set(auth(managerToken)).expect(200);
    expect(approved.body.data.count.status).toBe("approved");
    await request(http).post(`/api/v1/stock/counts/${counted.body.data.count.id}/approve`).set(auth(managerToken)).expect(409);
    const product = await request(http).get(`/api/v1/products/${riceId}`).set(auth(a.token)).expect(200);
    expect(product.body.data.product.stock.quantity).toBe("12000");

    // An owner's own count is applied at once.
    const ownerCount = await request(http).post("/api/v1/stock/counts").set(auth(a.token)).send({ productId: riceId, countedQuantity: "12", unit: "bag" }).expect(201);
    expect(ownerCount.body.data.count).toMatchObject({ status: "approved", difference: "0" });
    expect((await ledger.trialBalance(a.tenantId, a.businessId)).balanced).toBe(true);
  });

  it("flags products below zero instead of correcting them, and lists low stock", async () => {
    const http = app.getHttpServer();
    await request(http).post("/api/v1/stock/adjust").set(auth(a.token)).send({ productId: riceId, direction: "remove", reason: "missing", quantity: "15", unit: "bag", note: "Not on the shelf" }).expect(201);
    const product = await request(http).get(`/api/v1/products/${riceId}`).set(auth(a.token)).expect(200);
    expect(product.body.data.product.stock).toMatchObject({ quantity: "-3000", belowZero: true, low: true });
    const flagged = await request(http).get("/api/v1/stock/below-zero").set(auth(a.token)).expect(200);
    expect(flagged.body.data.items.map((item: { name: string }) => item.name)).toEqual(["Rice 50kg"]);
    const low = await request(http).get("/api/v1/stock/low").set(auth(salesToken)).expect(200);
    expect(low.body.data.items.map((item: { name: string }) => item.name)).toContain("Rice 50kg");
    await request(http).post("/api/v1/stock/receive").set(auth(a.token)).send({ productId: riceId, quantity: "10", unit: "bag", totalCostMinor: "80000000" }).expect(201);
    const cleared = await request(http).get("/api/v1/stock/below-zero").set(auth(a.token)).expect(200);
    expect(cleared.body.data.items).toEqual([]);
    expect((await ledger.trialBalance(a.tenantId, a.businessId)).balanced).toBe(true);
  });

  it("refuses to change or delete stock movements in the database", async () => {
    await expect(client.query("UPDATE stock_movements SET quantity = 1 WHERE tenant_id = $1", [a.tenantId])).rejects.toThrow(/cannot be changed/);
    await expect(client.query("DELETE FROM stock_movements WHERE tenant_id = $1", [a.tenantId])).rejects.toThrow(/cannot be changed/);
  });

  it("syncs offline stock in and counts once, and downloads products for offline lookup", async () => {
    const http = app.getHttpServer();
    const receiveId = uuidv7();
    offlineReceiveId = receiveId;
    const countId = uuidv7();
    const ops = [
      { id: uuidv7(), type: "stock.receive", occurredAt: new Date().toISOString(), payload: { id: receiveId, productId: riceId, quantity: "1", unit: "bag" } },
      { id: uuidv7(), type: "stock.count", occurredAt: new Date().toISOString(), payload: { id: countId, productId: riceId, countedQuantity: "8", unit: "bag" } },
    ];
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(storekeeperToken)).send({ operations: ops }).expect(200);
    expect(pushed.body.data.results.map((result: { status: string }) => result.status)).toEqual(["applied", "applied"]);
    expect(pushed.body.data.results[0].result.movementId).toBe(receiveId);
    const again = await request(http).post("/api/v1/sync/push").set(auth(storekeeperToken)).send({ operations: ops }).expect(200);
    expect(again.body.data.results.map((result: { status: string }) => result.status)).toEqual(["duplicate", "duplicate"]);
    const sales = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [{ ...ops[0], id: uuidv7(), payload: { ...ops[0]?.payload, id: uuidv7() } }] }).expect(200);
    expect(sales.body.data.results[0]).toMatchObject({ status: "rejected", error: { code: "FORBIDDEN" } });

    const first = await request(http).get("/api/v1/products/sync").set(auth(salesToken)).expect(200);
    expect(first.body.data.products.length).toBe(2);
    expect(first.body.data.products[0]).not.toHaveProperty("defaultCostMinor");
    expect(first.body.data.balances.length).toBeGreaterThan(0);
    expect(first.body.data.done).toBe(true);
    const nothingNew = await request(http)
      .get("/api/v1/products/sync")
      .query({ products: first.body.data.cursors.products, balances: first.body.data.cursors.balances })
      .set(auth(salesToken))
      .expect(200);
    expect(nothingNew.body.data.products).toEqual([]);
    expect(nothingNew.body.data.balances).toEqual([]);
    await request(http).patch(`/api/v1/products/${riceId}`).set(auth(a.token)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "9000000", lowStockLevel: "5", changeReason: "New price list" }).expect(200);
    const changed = await request(http)
      .get("/api/v1/products/sync")
      .query({ products: first.body.data.cursors.products, balances: first.body.data.cursors.balances })
      .set(auth(salesToken))
      .expect(200);
    expect(changed.body.data.products.map((item: { priceMinor: string }) => item.priceMinor)).toEqual(["9000000"]);
  });

  it("keeps each organization's products and stock to itself", async () => {
    const http = app.getHttpServer();
    await request(http).get(`/api/v1/products/${riceId}`).set(auth(b.token)).expect(404);
    await request(http).post("/api/v1/stock/receive").set(auth(b.token)).send({ productId: riceId, quantity: "1", unit: "bag" }).expect(404);
    await request(http).post("/api/v1/stock/transfer").set(auth(a.token)).send({ productId: riceId, toBranchId: b.branchId, quantity: "1", unit: "bag" }).expect(404);
    const list = await request(http).get("/api/v1/products").set(auth(b.token)).expect(200);
    expect(list.body.data.total).toBe(0);
    const pull = await request(http).get("/api/v1/products/sync").set(auth(b.token)).expect(200);
    expect(pull.body.data.products).toEqual([]);
    const replay = await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(b.token))
      .send({ id: offlineReceiveId, productId: riceId, quantity: "1", unit: "bag" })
      .expect(409);
    expect(replay.body.error.code).toBe("ID_CONFLICT");
    expect((await ledger.trialBalance(b.tenantId, b.businessId)).totalDebitMinor).toBe(0n);
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
