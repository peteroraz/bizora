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

type Counted = { systemQuantity: string; countedQuantity: string; difference: string };
type Applied = { product?: { id: string; name: string }; waiting?: boolean; count?: Counted & { lines: Counted[] } };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ADR-064: stock work done with no network", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let keeper = "";
  let riceId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const push = async (token: string, operations: { type: string; payload: unknown; occurredAt?: string; id?: string }[]) =>
    (
      await request(http)
        .post("/api/v1/sync/push")
        .set(auth(token))
        .send({ operations: operations.map((operation) => ({ id: operation.id ?? uuidv7(), occurredAt: operation.occurredAt ?? new Date().toISOString(), type: operation.type, payload: operation.payload })) })
        .expect(200)
    ).body.data.results as { status: string; result?: Applied; error?: { code: string } }[];
  const onHand = async (productId: string) => (await request(http).get(`/api/v1/products/${productId}`).set(auth(owner)).expect(200)).body.data.product.stock.quantity as string;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@offline.test", password, displayName: "Kemi Owner", organizationName: "Kemi Provisions", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Kemi Provisions", branchName: "Main" }).expect(200);
    keeper = await invite(http, owner, "keeper@offline.test", "INVENTORY", branchId, businessId);
    riceId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "8000000", openingQuantity: "10", openingCostMinor: "70000000" }).expect(201)).body.data.product.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("adds a product made offline, once, and a sale of it sent after it", async () => {
    const productId = uuidv7();
    const create = { id: uuidv7(), type: "product.create", payload: { id: productId, name: "Golden Penny spaghetti", baseUnit: "pack", priceMinor: "120000", trackStock: true, openingQuantity: "20" } };
    const sale = { type: "sale.create", payload: { id: uuidv7(), provisionalNumber: "DEV1-000001", soldAt: new Date().toISOString(), lines: [{ productId, quantity: "2", unit: "pack" }], payments: [{ method: "cash", amountMinor: "240000" }] } };
    const results = await push(owner, [create, sale]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    expect(results[0]!.result!.product).toMatchObject({ id: productId, name: "Golden Penny spaghetti" });
    expect(await onHand(productId)).toBe("18000");
    // Sent again (the phone did not hear back): nothing is added twice.
    const again = await push(owner, [create]);
    expect(again[0]!.status).not.toBe("rejected");
    expect((await client.query(`SELECT count(*)::int AS n FROM products WHERE name = 'Golden Penny spaghetti'`)).rows[0]).toEqual({ n: 1 });
  });

  it("takes stock off offline, and a store keeper's change still waits for a manager", async () => {
    const [direct] = await push(owner, [{ type: "stock.adjust", payload: { productId: riceId, direction: "remove", reason: "damaged", quantity: "1", unit: "bag", note: "Bag torn by rats" } }]);
    expect(direct!.status).toBe("applied");
    expect(await onHand(riceId)).toBe("9000");
    const [asked] = await push(keeper, [{ type: "stock.adjust", payload: { productId: riceId, direction: "remove", reason: "missing", quantity: "1", unit: "bag", note: "Cannot find one bag" } }]);
    expect(asked!.status).toBe("applied");
    expect(asked!.result).toMatchObject({ waiting: true });
    expect(await onHand(riceId)).toBe("9000");
    const requests = (await request(http).get("/api/v1/stock/requests").set(auth(owner)).expect(200)).body.data.waiting;
    expect(requests).toHaveLength(1);
  });

  it("compares a count line made offline with the stock when it was counted, not when it arrived", async () => {
    const session = (await request(http).post("/api/v1/inventory/counts").set(auth(keeper)).send({ id: uuidv7(), name: "Friday count" }).expect(201)).body.data.count;
    await pause(30);
    const countedAt = new Date().toISOString();
    await pause(30);
    // Two bags are sold after the count, before the phone is back online.
    await request(http).post("/api/v1/sales").set(auth(owner)).send({ lines: [{ productId: riceId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "16000000" }] }).expect(201);
    const [line] = await push(keeper, [{ type: "stock.count_line", occurredAt: countedAt, payload: { sessionId: session.id, productId: riceId, countedQuantity: "9", unit: "bag" } }]);
    expect(line!.status).toBe("applied");
    expect(line!.result!.count!.lines[0]).toMatchObject({ systemQuantity: "9000", countedQuantity: "9000", difference: "0" });
    const [missing] = await push(keeper, [{ type: "stock.count_line", payload: { productId: riceId, countedQuantity: "9", unit: "bag" } }]);
    expect(missing!.status).toBe("rejected");
  });

  it("does the same for a single count, and does not reach back more than a week", async () => {
    const countedAt = new Date().toISOString();
    await pause(30);
    await request(http).post("/api/v1/sales").set(auth(owner)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8000000" }] }).expect(201);
    const [count] = await push(owner, [{ type: "stock.count", occurredAt: countedAt, payload: { id: uuidv7(), productId: riceId, countedQuantity: "7", unit: "bag" } }]);
    expect(count!.result!.count!).toMatchObject({ systemQuantity: "7000", countedQuantity: "7000", difference: "0" });
    // In the future means now.
    const futureId = uuidv7();
    const [future] = await push(owner, [{ type: "stock.count", occurredAt: new Date(Date.now() + 86_400_000).toISOString(), payload: { id: futureId, productId: riceId, countedQuantity: "6", unit: "bag" } }]);
    expect(future!.result!.count!).toMatchObject({ systemQuantity: "6000", difference: "0" });
    // A phone clock a month back is taken as a week ago, no further.
    const oldId = uuidv7();
    await push(owner, [{ type: "stock.count", occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), payload: { id: oldId, productId: riceId, countedQuantity: "6", unit: "bag" } }]);
    const [stored] = (await client.query<{ days: number }>(`SELECT extract(epoch FROM now() - counted_at) / 86400 AS days FROM stock_counts WHERE id = '${oldId}'`)).rows;
    expect(Number(stored!.days)).toBeGreaterThan(6.9);
    expect(Number(stored!.days)).toBeLessThan(7.01);
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
