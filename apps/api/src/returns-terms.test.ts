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


const lagosDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe("ADR-059: a returns rule, and standard credit terms", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let cashier = "";
  let businessId = "";
  let riceId = "";
  let dantataId = "";
  let walkInId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const today = lagosDay(new Date());

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@terms.test", password, displayName: "Musa Owner", organizationName: "Musa & Sons", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Musa & Sons", branchName: "Main" }).expect(200);
    manager = await invite(http, owner, "manager@terms.test", "MANAGER", branchId, businessId);
    cashier = await invite(http, owner, "cashier@terms.test", "CASHIER", branchId, businessId);
    riceId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ id: uuidv7(), name: "Rice 50kg", baseUnit: "bag", priceMinor: "7850000", openingQuantity: "100", openingCostMinor: "600000000" }).expect(201)).body.data.product.id as string;
    dantataId = (await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Dantata Stores", phone: "08037770001" }).expect(201)).body.data.customer.id as string;
    walkInId = (await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Garba Retail", phone: "08037770002" }).expect(201)).body.data.customer.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets a manager give a customer standard terms, and only someone who may approve credit", async () => {
    await request(http).patch(`/api/v1/customers/${dantataId}/credit`).set(auth(cashier)).send({ creditAllowed: true, creditTermsDays: 30 }).expect(403);
    const saved = await request(http).patch(`/api/v1/customers/${dantataId}/credit`).set(auth(manager)).send({ creditAllowed: true, creditTermsDays: 30 }).expect(200);
    expect(saved.body.data.customer.credit).toMatchObject({ allowed: true, termsDays: 30 });
    await request(http).patch(`/api/v1/customers/${dantataId}/credit`).set(auth(manager)).send({ creditAllowed: true, creditTermsDays: 400 }).expect(400);
    await request(http).patch(`/api/v1/customers/${walkInId}/credit`).set(auth(manager)).send({ creditAllowed: true }).expect(200);
  });

  it("sells on credit to a customer on terms with no date or comment, and still asks for both otherwise", async () => {
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(cashier))
      .send({ customerId: dantataId, lines: [{ productId: riceId, quantity: "20", unit: "bag" }], payments: [{ method: "transfer", amountMinor: "100000000" }] })
      .expect(201);
    expect(sale.body.data.sale).toMatchObject({ balanceMinor: "57000000", dueDate: addDays(today, 30) });
    const comments = await client.query<{ body: string }>("SELECT body FROM sale_comments WHERE sale_id = $1", [sale.body.data.sale.id]);
    expect(comments.rows.map((row) => row.body)).toEqual(["On 30-day terms."]);
    // A date given at the counter is kept.
    const sooner = await request(http)
      .post("/api/v1/sales")
      .set(auth(cashier))
      .send({ customerId: dantataId, dueDate: addDays(today, 7), lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [] })
      .expect(201);
    expect(sooner.body.data.sale.dueDate).toBe(addDays(today, 7));
    // Paid in full: no date and no comment.
    const paid = await request(http)
      .post("/api/v1/sales")
      .set(auth(cashier))
      .send({ customerId: dantataId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7850000" }] })
      .expect(201);
    expect(paid.body.data.sale.dueDate).toBeNull();
    // No terms: the date and the comment are still needed.
    const refused = await request(http)
      .post("/api/v1/sales")
      .set(auth(cashier))
      .send({ customerId: walkInId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [] })
      .expect(400);
    expect(refused.body.error.code).toBe("DUE_DATE_REQUIRED");
  });

  it("takes goods back within the business's days, and only the owner later than that", async () => {
    await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(manager)).send({ returnsWithinDays: 3 }).expect(403);
    const set = await request(http).patch(`/api/v1/businesses/${businessId}`).set(auth(owner)).send({ returnsWithinDays: 3, returnsOnReceipt: true }).expect(200);
    expect(JSON.stringify(set.body.data)).toContain('"returnsWithinDays":3');
    const old = uuidv7();
    const soldAt = `${addDays(today, -5)}T10:00:00.000Z`;
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(cashier))
      .send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: soldAt, payload: { id: old, soldAt, lines: [{ productId: riceId, quantity: "2", unit: "bag", unitPriceMinor: "7850000" }], payments: [{ method: "cash", amountMinor: "15700000" }] } }] })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    const lineId = (await request(http).get(`/api/v1/sales/${old}`).set(auth(owner)).expect(200)).body.data.sale.lines[0].id as string;
    const late = await request(http)
      .post(`/api/v1/sales/${old}/returns`)
      .set(auth(manager))
      .send({ lines: [{ saleLineId: lineId, quantity: "1" }], refundMethod: "cash", reason: "Weevils" })
      .expect(403);
    expect(late.body.error).toMatchObject({ code: "RETURN_TOO_LATE" });
    expect(late.body.error.message).toContain("5 days ago");
    await request(http).post(`/api/v1/sales/${old}/returns`).set(auth(owner)).send({ id: uuidv7(), lines: [{ saleLineId: lineId, quantity: "1" }], refundMethod: "cash", reason: "Weevils" }).expect(201);
    // A sale from today is fine for the manager.
    const fresh = await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7850000" }] }).expect(201);
    await request(http)
      .post(`/api/v1/sales/${fresh.body.data.sale.id}/returns`)
      .set(auth(manager))
      .send({ id: uuidv7(), lines: [{ saleLineId: fresh.body.data.sale.lines[0].id, quantity: "1" }], refundMethod: "cash", reason: "Changed mind" })
      .expect(201);
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
