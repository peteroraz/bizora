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

describe("ADR-062: serial numbers and IMEIs", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let phoneId = "";
  let caseId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sell = (token: string, lines: Record<string, unknown>[], status = 201) =>
    request(http).post("/api/v1/sales").set(auth(token)).send({ lines, payments: [{ method: "cash", amountMinor: String(lines.reduce((sum, line) => sum + Number(line.quantity) * 16500000, 0)) }] }).expect(status);
  const find = async (q: string, token = owner) => (await request(http).get(`/api/v1/stock/serials?q=${encodeURIComponent(q)}`).set(auth(token)).expect(200)).body.data.items;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@serial.test", password, displayName: "Chidi Owner", organizationName: "Chidi Phones", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Chidi Phones", branchName: "Main" }).expect(200);
    cashier = await invite(http, owner, "cashier@serial.test", "CASHIER", branchId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@serial.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
    phoneId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Samsung A15", baseUnit: "piece", priceMinor: "16500000", tracksSerials: true }).expect(201)).body.data.product.id as string;
    caseId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Phone case", baseUnit: "piece", priceMinor: "16500000", openingQuantity: "5" }).expect(201)).body.data.product.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("records one serial per unit coming in, and refuses one already in stock", async () => {
    const receive = (quantity: string, serials: string[]) =>
      request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId: phoneId, quantity, unit: "piece", paidFrom: "cash", totalCostMinor: "45000000", serials });
    await receive("3", ["35 2099 0017 6148 1", "352099001761482", "352099001761483"]).expect(201);
    const listed = (await request(http).get(`/api/v1/products/${phoneId}/serials`).set(auth(cashier)).expect(200)).body.data;
    expect(listed.tracksSerials).toBe(true);
    expect(listed.items.map((item: { serial: string }) => item.serial)).toEqual(["352099001761481", "352099001761482", "352099001761483"]);
    expect((await receive("1", ["352099001761481"]).expect(409)).body.error.code).toBe("SERIAL_IN_STOCK");
    expect((await receive("1", ["A1", "A2"]).expect(422)).body.error.code).toBe("SERIALS_TOO_MANY");
    await receive("1", ["A1", "a1"]).expect(400);
    // A product that does not keep serial numbers says so.
    const plain = await request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId: caseId, quantity: "1", unit: "piece", paidFrom: "cash", serials: ["X100"] }).expect(422);
    expect(plain.body.error.code).toBe("SERIALS_NOT_KEPT");
  });

  it("links a sold unit to its sale, and never sells the same serial twice at the counter", async () => {
    const sale = (await sell(cashier, [{ productId: phoneId, quantity: "1", unit: "piece", serials: ["352099001761481"] }])).body.data.sale;
    expect(sale.lines[0].serials).toEqual(["352099001761481"]);
    const [found] = await find("352099001761481");
    expect(found).toMatchObject({ status: "sold", productName: "Samsung A15", saleNumber: sale.number, branchName: "Main" });
    expect(found.history.map((event: { event: string }) => event.event)).toEqual(["received", "sold"]);

    const refused = await sell(cashier, [{ productId: phoneId, quantity: "1", unit: "piece", serials: ["352099001761481"] }], 409);
    expect(refused.body.error.code).toBe("SERIAL_ALREADY_SOLD");
    expect(refused.body.error.message).toContain("was already sold");
    // The refused sale left nothing behind: one unit left the shelf, two are still there.
    expect((await request(http).get(`/api/v1/products/${phoneId}/serials`).set(auth(owner)).expect(200)).body.data.items).toHaveLength(2);
  });

  it("keeps an offline sale with a serial already sold, leaves the serial off and tells the owner", async () => {
    const offline = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), provisionalNumber: "DEV7-000001", soldAt: new Date(Date.now() - 600_000).toISOString(), lines: [{ productId: phoneId, quantity: "1", unit: "piece", serials: ["352099001761481"] }], payments: [{ method: "cash", amountMinor: "16500000" }] } };
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [offline] }).expect(200);
    expect(pushed.body.data.results[0].status).not.toBe("rejected");
    const kept = (await request(http).get(`/api/v1/sales/${offline.payload.id}`).set(auth(owner)).expect(200)).body.data.sale;
    expect(kept.lines[0].serials).toEqual([]);
    const inbox = (await request(http).get("/api/v1/notifications").set(auth(owner)).expect(200)).body.data.items;
    expect(inbox.find((item: { kind: string }) => item.kind === "sale.serial_conflict")).toMatchObject({ saleId: offline.payload.id });
    expect((await find("352099001761481"))[0].saleId).not.toBe(kept.id);
  });

  it("records serials after the sale, one per unit sold, and records a serial never seen as sold", async () => {
    const sale = (await sell(cashier, [{ productId: phoneId, quantity: "1", unit: "piece" }])).body.data.sale;
    const lineId = sale.lines[0].id as string;
    await request(http).post(`/api/v1/sales/${sale.id}/serials`).set(auth(cashier)).send({ lines: [{ saleLineId: lineId, serials: ["352099001761482", "352099001761483"] }] }).expect(422);
    const added = await request(http).post(`/api/v1/sales/${sale.id}/serials`).set(auth(cashier)).send({ lines: [{ saleLineId: lineId, serials: ["352099001761482"] }] }).expect(200);
    expect(added.body.data.sale.lines[0].serials).toEqual(["352099001761482"]);
    // A phone from before serials were kept: recorded now, as sold, and it cannot be sold again.
    await request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ productId: phoneId, quantity: "1", unit: "piece", paidFrom: "cash", totalCostMinor: "15000000" }).expect(201);
    const old = (await sell(cashier, [{ productId: phoneId, quantity: "1", unit: "piece", serials: ["OLD-STOCK-77"] }])).body.data.sale;
    expect((await find("OLD-STOCK"))[0]).toMatchObject({ status: "sold", saleId: old.id });
    expect((await find("OLD-STOCK"))[0].history[0].note).toBe("Not recorded when it came in");
    await request(http).post(`/api/v1/sales/${sale.id}/serials`).set(auth(other)).send({ lines: [{ saleLineId: lineId, serials: ["X999"] }] }).expect(404);
  });

  it("brings a returned unit back so it can be sold again, and a cancelled sale's units back to stock", async () => {
    const [first] = await find("352099001761481");
    const sale = (await request(http).get(`/api/v1/sales/${first.saleId}`).set(auth(owner)).expect(200)).body.data.sale;
    await request(http).post(`/api/v1/sales/${sale.id}/returns`).set(auth(owner)).send({ lines: [{ saleLineId: sale.lines[0].id, quantity: "1" }], reason: "Screen fault" }).expect(201);
    expect((await find("352099001761481"))[0]).toMatchObject({ status: "returned", saleId: null });
    const again = (await sell(cashier, [{ productId: phoneId, quantity: "1", unit: "piece", serials: ["352099001761481"] }])).body.data.sale;
    expect((await find("352099001761481"))[0]).toMatchObject({ status: "sold", saleId: again.id });

    await request(http).post(`/api/v1/sales/${again.id}/void`).set(auth(owner)).send({ reason: "Wrong phone" }).expect(200);
    const back = (await find("352099001761481"))[0];
    expect(back).toMatchObject({ status: "in_stock", saleId: null });
    expect(back.history.map((event: { event: string }) => event.event)).toEqual(["received", "sold", "returned", "sold", "sale_cancelled"]);
  });

  it("finds units only within the business, and needs a few characters", async () => {
    await request(http).get("/api/v1/stock/serials?q=35").set(auth(owner)).expect(400);
    expect(await find("3520990017", other)).toEqual([]);
    await request(http).get(`/api/v1/products/${phoneId}/serials`).set(auth(other)).expect(404);
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
