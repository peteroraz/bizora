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
// "Today" in the shop's timezone, as Bizora counts it. UTC would be a day behind between 23:00 and midnight UTC.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());


describe("sprint 7c: suppliers and what is owed to them", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let storekeeper = "";
  let riceId = "";
  let dangoteId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const receive = (token: string, body: Record<string, unknown>) =>
    request(http).post("/api/v1/stock/receive").set(auth(token)).send({ productId: riceId, quantity: "1", unit: "piece", ...body });
  /** A storekeeper's delivery waits for a manager (ADR-034), who approves it here. */
  const approved = async (asked: request.Response) => {
    expect(asked.body.data.waiting).toBe(true);
    await request(http).post(`/api/v1/stock/requests/${asked.body.data.request.id}/approve`).set(auth(manager)).send({}).expect(200);
  };
  const supplier = async (id: string) => (await request(http).get(`/api/v1/suppliers/${id}`).set(auth(owner)).expect(200)).body.data;
  const owedInBooks = async () => {
    const balance = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    const payable = (balance.body.data.accounts as { code: string; balanceMinor: string }[]).find((account) => account.code === "2000");
    return (-BigInt(payable?.balanceMinor ?? "0")).toString();
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
        email: "owner@suppliers.test",
        password,
        displayName: "Musa Owner",
        organizationName: "Musa Provisions",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Musa Provisions", branchName: "Main" })
      .expect(200);
    manager = await invite(http, owner, "manager@suppliers.test", "MANAGER", branchId, businessId);
    storekeeper = await invite(http, owner, "store@suppliers.test", "INVENTORY", branchId, businessId);
    const product = await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Rice 50kg", baseUnit: "piece", priceMinor: "8000000" }).expect(201);
    riceId = product.body.data.product.id as string;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("a storekeeper receives stock owed to a supplier named on the spot; they see names, not money", async () => {
    await approved(await receive(storekeeper, { quantity: "10", totalCostMinor: "50000000", paidFrom: "credit", supplier: "  dangote   distributors ", payBy: shift(-1) }).expect(201));
    const names = await request(http).get("/api/v1/suppliers/names?q=dang").set(auth(storekeeper)).expect(200);
    expect(names.body.data.items).toHaveLength(1);
    dangoteId = names.body.data.items[0].id;
    expect(names.body.data.items[0].name).toBe("dangote distributors");
    await request(http).get("/api/v1/suppliers").set(auth(storekeeper)).expect(403);
    await request(http).get(`/api/v1/suppliers/${dangoteId}`).set(auth(storekeeper)).expect(403);
    const list = await request(http).get("/api/v1/suppliers").set(auth(owner)).expect(200);
    expect(list.body.data).toMatchObject({ owedMinor: "50000000", overdueMinor: "50000000", owing: 1 });
  });

  it("adds up deliveries by supplier, keeps paid deliveries in the history, and keeps unnamed credit", async () => {
    await receive(manager, { quantity: "6", totalCostMinor: "30000000", paidFrom: "credit", supplierId: dangoteId, payBy: shift(14) }).expect(201);
    // Paid in cash, the name in other capitals: the same supplier, nothing more owed.
    await receive(manager, { quantity: "2", totalCostMinor: "10000000", paidFrom: "cash", supplier: "DANGOTE DISTRIBUTORS" }).expect(201);
    await approved(await receive(storekeeper, { quantity: "1", totalCostMinor: "5000000" }).expect(201));
    const dangote = await supplier(dangoteId);
    expect(dangote).toMatchObject({ owedMinor: "80000000", overdueMinor: "50000000", nextPayBy: shift(14) });
    expect(dangote.entries).toHaveLength(2);
    expect(dangote.entries[0]).toMatchObject({ kind: "purchase", product: "Rice 50kg", quantity: "6000", canCancel: false });
    expect(dangote.paidDeliveries).toHaveLength(1);
    const list = await request(http).get("/api/v1/suppliers").set(auth(owner)).expect(200);
    expect(list.body.data.items.map((item: { name: string; unnamed: boolean }) => [item.name, item.unnamed])).toEqual([
      ["dangote distributors", false],
      ["Supplier not named", true],
    ]);
    expect(list.body.data.owedMinor).toBe("85000000");
    expect(await owedInBooks()).toBe("85000000");
  });

  it("pays a supplier from the drawer, oldest debt first, never more than owed", async () => {
    await request(http).post(`/api/v1/suppliers/${dangoteId}/payments`).set(auth(storekeeper)).send({ amountMinor: "100", paidFrom: "cash" }).expect(403);
    const tooMuch = await request(http).post(`/api/v1/suppliers/${dangoteId}/payments`).set(auth(manager)).send({ amountMinor: "80000001", paidFrom: "cash" }).expect(400);
    expect(tooMuch.body.error.code).toBe("MORE_THAN_OWED");
    const paid = await request(http)
      .post(`/api/v1/suppliers/${dangoteId}/payments`)
      .set(auth(manager))
      .send({ id: uuidv7(), amountMinor: "60000000", paidFrom: "cash", note: "Part payment" })
      .expect(201);
    expect(paid.body.data).toMatchObject({ owedMinor: "20000000", overdueMinor: "0", nextPayBy: shift(14) });
    expect(paid.body.data.entries[0]).toMatchObject({ kind: "payment", paidFrom: "cash", amountMinor: "60000000", shop: "Main" });
    // The drawer shows the supplier paid in cash.
    const cash = await request(http).get("/api/v1/money/cash").set(auth(owner)).expect(200);
    expect(cash.body.data.shops[0].flows.find((flow: { kind: string }) => flow.kind === "suppliers")).toMatchObject({ outMinor: "60000000" });
    expect(await owedInBooks()).toBe("25000000");
  });

  it("adds a supplier with a checked phone, and what was owed before Bizora", async () => {
    await request(http).post("/api/v1/suppliers").set(auth(manager)).send({ name: "Mama Nkechi Oils", phone: "0803 123" }).expect(400);
    const added = await request(http).post("/api/v1/suppliers").set(auth(manager)).send({ name: "Mama Nkechi Oils", phone: "0803 123 4567" }).expect(201);
    expect(added.body.data.supplier).toMatchObject({ name: "Mama Nkechi Oils", phoneE164: "+2348031234567" });
    await request(http).post("/api/v1/suppliers").set(auth(manager)).send({ name: "mama nkechi oils" }).expect(409);
    const id = added.body.data.supplier.id as string;
    const opening = await request(http).post(`/api/v1/suppliers/${id}/opening`).set(auth(manager)).send({ amountMinor: "1500000", payBy: shift(7) }).expect(201);
    expect(opening.body.data).toMatchObject({ owedMinor: "1500000", nextPayBy: shift(7) });
    expect(await owedInBooks()).toBe("26500000");
    await request(http).patch(`/api/v1/suppliers/${id}`).set(auth(manager)).send({ archived: true }).expect(409);
  });

  it("only the owner cancels a payment; it puts the debt back; deliveries are corrected in stock", async () => {
    const dangote = await supplier(dangoteId);
    const payment = dangote.entries.find((entry: { kind: string }) => entry.kind === "payment");
    const purchase = dangote.entries.find((entry: { kind: string }) => entry.kind === "purchase");
    expect(payment.canCancel).toBe(true);
    await request(http).post(`/api/v1/suppliers/entries/${payment.id}/void`).set(auth(manager)).send({ reason: "Wrong amount" }).expect(403);
    await request(http).post(`/api/v1/suppliers/entries/${purchase.id}/void`).set(auth(owner)).send({ reason: "Wrong" }).expect(409);
    const undone = await request(http).post(`/api/v1/suppliers/entries/${payment.id}/void`).set(auth(owner)).send({ reason: "Wrong amount" }).expect(200);
    expect(undone.body.data).toMatchObject({ owedMinor: "80000000", overdueMinor: "50000000" });
    expect(await owedInBooks()).toBe("86500000");
    const balance = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    expect(balance.body.data.balanced).toBe(true);
  });

  it("moves stock already bought on credit onto suppliers when the change is first applied", async () => {
    // As before 7c: deliveries with only a typed name, and no supplier records.
    await client.exec(
      "DELETE FROM supplier_entries; DELETE FROM supplier_products; ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_immutable; UPDATE stock_movements SET supplier_id = NULL; ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_immutable; DELETE FROM suppliers;",
    );
    const migration = (await loadMigrationSql()).find((item) => item.id.startsWith("0026"));
    await client.exec(migration?.sql ?? "");
    const list = await request(http).get("/api/v1/suppliers").set(auth(owner)).expect(200);
    expect(list.body.data.items.map((item: { name: string; owedMinor: string }) => [item.name, item.owedMinor])).toEqual([
      ["dangote distributors", "80000000"],
      ["Supplier not named", "5000000"],
    ]);
    expect(list.body.data.owedMinor).toBe("85000000");
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
