import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { parseSpokenSale, buildReview } from "@bizora/contracts/voice";
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

describe("ADR-040: a sale spoken offline syncs once and keeps the books right", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let businessId = "";
  let branchId = "";
  let riceId = "";
  let emekaId = "";

  let noCreditId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const push = (token: string, operations: unknown[]) => request(http).post("/api/v1/sync/push").set(auth(token)).send({ operations });

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@voice.test", password, displayName: "Ifeoma Owner", organizationName: "Ifeoma Foods", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ifeoma Foods", branchName: "Main" })
      .expect(200);
    cashier = await invite(http, owner, "cashier@voice.test", "CASHIER", branchId, businessId);
    const product = await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", openingQuantity: "10", openingCostMinor: "60000000" }).expect(201);
    riceId = product.body.data.product.id as string;
    emekaId = (await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Emeka Obi", phone: "08031234567" }).expect(201)).body.data.customer.id as string;
    await request(http).patch(`/api/v1/customers/${emekaId}/credit`).set(auth(owner)).send({ creditAllowed: true }).expect(200);
    await (await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Bola Walk In", isWalkIn: true }).expect(201));
    noCreditId = (await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Chinedu Eze", phone: "08039999999" }).expect(201)).body.data.customer.id as string;
    const second = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "other@voice.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true })
      .expect(201);
    other = second.body.data.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("gives a bounded list of customer names for matching offline, never phones", async () => {
    const all = await request(http).get("/api/v1/customers/directory").set(auth(owner)).expect(200);
    expect(all.body.data.scope).toBe("all");
    expect(all.body.data.items.map((item: { name: string }) => item.name).sort()).toEqual(["Bola Walk In", "Chinedu Eze", "Emeka Obi"]);
    expect(Object.keys(all.body.data.items[0]).sort()).toEqual(["creditAllowed", "id", "name"]);
    // The directory is names only. Match the whole phone numbers: a short piece such as 803 also turns up inside an id.
    const directory = JSON.stringify(all.body.data);
    expect(directory).not.toContain("08031234567");
    expect(directory).not.toContain("08039999999");
    expect(directory).not.toContain("phone");
    // A cashier sees only customers approved for credit and those who bought here lately.
    const limited = await request(http).get("/api/v1/customers/directory").set(auth(cashier)).expect(200);
    expect(limited.body.data.scope).toBe("credit_and_recent");
    expect(limited.body.data.items.map((item: { name: string }) => item.name)).toEqual(["Emeka Obi"]);
    // Another business sees none of them.
    expect((await request(http).get("/api/v1/customers/directory").set(auth(other)).expect(200)).body.data.items).toEqual([]);
  });

  it("syncs the brief's spoken sale once: stock, payment, what is owed and the books", async () => {
    // What the phone works out offline from the words.
    const spoken = parseSpokenSale("I sold five bags of rice at seventy-five thousand naira each to Emeka. He paid three hundred thousand and will balance seventy-five thousand.", { currency: "NGN" });
    const review = buildReview(
      spoken,
      [{ id: riceId, name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", packs: [] }],
      [{ id: emekaId, name: "Emeka Obi", creditAllowed: true }],
      { canChangePrice: false, canGiveCredit: true },
    );
    expect(review.warnings).toEqual([]);
    const saleId = uuidv7();
    const op = {
      id: uuidv7(),
      type: "sale.create",
      occurredAt: new Date().toISOString(),
      payload: {
        id: saleId,
        provisionalNumber: "DEV1-000001",
        soldAt: new Date().toISOString(),
        lines: review.lines.map((line) => ({ productId: line.product!.id, quantity: "5", unit: line.unit })),
        payments: [{ method: "cash", amountMinor: String(review.paidMinor) }],
        customerId: review.customer!.id,
        dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        comment: "Will balance next week (said by voice)",
      },
    };
    const first = await push(cashier, [op]).expect(200);
    expect(first.body.data.results[0].status).toBe("applied");
    expect(first.body.data.results[0].result.sale).toMatchObject({ id: saleId, totalMinor: "37500000", source: "offline" });
    // The phone never heard back and sends it again, twice.
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await push(cashier, [op]).expect(200)).body.data.results[0].status).toBe("duplicate");
    // The same sale ID under a new operation ID is not a second sale.
    // Sent again under a new operation ID, it is still the same sale, not a second one.
    const reused = await push(cashier, [{ ...op, id: uuidv7() }]).expect(200);
    expect(reused.body.data.results[0].result.sale.id).toBe(saleId);

    const sales = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sales WHERE id = $1", [saleId]);
    expect(sales.rows[0]?.n).toBe(1);
    const stock = await request(http).get(`/api/v1/products/${riceId}`).set(auth(owner)).expect(200);
    // 10 bags less the 5 sold, once.
    expect(stock.body.data.product.stock).toMatchObject({ quantity: "5000", belowZero: false });
    const debtors = await request(http).get("/api/v1/debtors").set(auth(owner)).expect(200);
    expect(debtors.body.data.items).toEqual([expect.objectContaining({ customerId: emekaId, owingMinor: "7500000" })]);
    const payments = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sale_payments WHERE sale_id = $1", [saleId]);
    expect(payments.rows[0]?.n).toBe(1);
    const books = (await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200)).body.data;
    expect(books.balanced).toBe(true);
    const entries = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'sale' AND source_id = $1", [saleId]);
    expect(entries.rows[0]?.n).toBe(1);
  });

  it("refuses, without losing it, a spoken sale the server cannot accept", async () => {
    // A customer who is not approved for credit, and a customer from another business.
    const base = { provisionalNumber: "DEV1-000002", soldAt: new Date().toISOString(), lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "5000000" }], dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), comment: "Balance later" };
    const noCredit = await push(cashier, [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { ...base, id: uuidv7(), customerId: noCreditId } }]).expect(200);
    expect(noCredit.body.data.results[0].status).toBe("rejected");
    const foreign = await push(other, [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { ...base, id: uuidv7(), customerId: emekaId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }] } }]).expect(200);
    expect(foreign.body.data.results[0].status).toBe("rejected");
    const books = (await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200)).body.data;
    expect(books.balanced).toBe(true);
  });

  it("records a spoken sale made offline when the shelf ran out meanwhile, and flags it", async () => {
    const op = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), provisionalNumber: "DEV1-000003", soldAt: new Date().toISOString(), lines: [{ productId: riceId, quantity: "8", unit: "bag" }], payments: [{ method: "cash", amountMinor: "60000000" }] } };
    const result = await push(cashier, [op]).expect(200);
    expect(result.body.data.results[0].status).toBe("applied");
    const product = await request(http).get(`/api/v1/products/${riceId}`).set(auth(owner)).expect(200);
    // 5 left, 8 sold offline: recorded as it happened, and shown below zero for someone to count.
    expect(product.body.data.product.stock).toMatchObject({ quantity: "-3000", belowZero: true });
  });

  it("does not accept work without a valid sign-in", async () => {
    await request(http).post("/api/v1/sync/push").send({ operations: [] }).expect(401);
    await request(http).post("/api/v1/sync/push").set(auth("not-a-token")).send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: {} }] }).expect(401);
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
