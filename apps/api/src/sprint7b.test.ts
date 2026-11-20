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


describe("sprint 7b: money in and out, cash per shop, profit", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let cashier = "";
  let accountant = "";
  let branchId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const categories = new Map<string, string>();

  const cash = async (token = owner) => {
    const response = await request(http).get("/api/v1/money/cash").set(auth(token)).expect(200);
    return response.body.data.shops[0] as {
      expectedMinor: string;
      openingMinor: string;
      flows: { kind: string; inMinor: string; outMinor: string }[];
      counts: { countedMinor: string; expectedMinor: string; differenceMinor: string }[];
    };
  };
  const flow = (shop: Awaited<ReturnType<typeof cash>>, kind: string) => shop.flows.find((item) => item.kind === kind);

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
        email: "owner@money.test",
        password,
        displayName: "Ngozi Owner",
        organizationName: "Ngozi Provisions",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ngozi Provisions", branchName: "Main" })
      .expect(200);
    manager = await invite(http, owner, "manager@money.test", "MANAGER", branchId, businessId);
    cashier = await invite(http, owner, "cashier@money.test", "CASHIER", branchId, businessId);
    accountant = await invite(http, owner, "accounts@money.test", "ACCOUNTANT", branchId, businessId);

    // ₦5,000 each, 10 in stock that cost ₦30,000; two sold for cash.
    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(owner))
      .send({ name: "Rice 5kg", baseUnit: "piece", priceMinor: "500000", openingQuantity: "10", openingCostMinor: "3000000" })
      .expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: product.body.data.product.id, quantity: "2", unit: "piece" }], payments: [{ method: "cash", amountMinor: "1000000" }] })
      .expect(201);
    const list = await request(http).get("/api/v1/money/categories").set(auth(manager)).expect(200);
    for (const category of list.body.data.categories as { id: string; name: string }[]) categories.set(category.name, category.id);
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("offers running costs as categories, not the accounts the system posts to", () => {
    expect(categories.has("Rent")).toBe(true);
    expect(categories.has("Transport and delivery")).toBe(true);
    expect(categories.has("Cost of goods sold")).toBe(false);
    expect(categories.has("Cash short or over")).toBe(false);
  });

  it("shows the cash a sale brought into the drawer", async () => {
    const shop = await cash();
    expect(flow(shop, "sales")).toMatchObject({ inMinor: "1000000", outMinor: "0" });
    expect(shop.expectedMinor).toBe("1000000");
  });

  it("a manager's expense waits for the owner; the owner's is approved straight away", async () => {
    const transport = await request(http)
      .post("/api/v1/money/expenses")
      .set(auth(manager))
      .send({ id: uuidv7(), categoryId: categories.get("Transport and delivery"), amountMinor: "150000", paidFrom: "cash", payee: "Okada to market" })
      .expect(201);
    expect(transport.body.data.expense).toMatchObject({ status: "awaiting_approval", canApprove: false, canCancel: true, shop: "Main" });
    expect((await cash()).expectedMinor).toBe("850000");
    await request(http).post(`/api/v1/money/expenses/${transport.body.data.expense.id}/approve`).set(auth(manager)).expect(403);
    const waiting = await request(http).get("/api/v1/money/expenses/waiting").set(auth(owner)).expect(200);
    expect(waiting.body.data).toMatchObject({ count: 1, amountMinor: "150000" });
    const approved = await request(http).post(`/api/v1/money/expenses/${transport.body.data.expense.id}/approve`).set(auth(owner)).expect(200);
    expect(approved.body.data.expense.status).toBe("approved");
    await request(http).post(`/api/v1/money/expenses/${transport.body.data.expense.id}/approve`).set(auth(owner)).expect(409);

    const rent = await request(http)
      .post("/api/v1/money/expenses")
      .set(auth(owner))
      .send({ categoryId: categories.get("Rent"), amountMinor: "2000000", paidFrom: "bank" })
      .expect(201);
    expect(rent.body.data.expense.status).toBe("approved");
    // Paid from the bank: the drawer is not touched.
    expect((await cash()).expectedMinor).toBe("850000");
  });

  it("refuses expenses for tomorrow, for accounts that are not running costs, and records a device ID once", async () => {
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await request(http)
      .post("/api/v1/money/expenses")
      .set(auth(owner))
      .send({ categoryId: categories.get("Rent"), amountMinor: "100", paidFrom: "cash", expenseDate: tomorrow })
      .expect(400);
    const accounts = await request(http).get("/api/v1/ledger/accounts").set(auth(owner)).expect(200);
    const cogs = (accounts.body.data.items as { id: string; role: string }[]).find((account) => account.role === "cogs");
    const refused = await request(http).post("/api/v1/money/expenses").set(auth(owner)).send({ categoryId: cogs?.id, amountMinor: "100", paidFrom: "cash" }).expect(400);
    expect(refused.body.error.fieldErrors[0].field).toBe("categoryId");
    const id = uuidv7();
    const body = { id, categoryId: categories.get("Phone and data"), amountMinor: "50000", paidFrom: "owner" };
    const first = await request(http).post("/api/v1/money/expenses").set(auth(owner)).send(body).expect(201);
    const again = await request(http).post("/api/v1/money/expenses").set(auth(owner)).send(body).expect(201);
    expect(again.body.data.expense.id).toBe(first.body.data.expense.id);
    // Paid by the owner from their own pocket: not from the drawer.
    expect((await cash()).expectedMinor).toBe("850000");
  });

  it("rejecting an expense reverses it and puts the cash back", async () => {
    const lunch = await request(http)
      .post("/api/v1/money/expenses")
      .set(auth(manager))
      .send({ categoryId: categories.get("Other expenses"), amountMinor: "70000", paidFrom: "cash", note: "Staff lunch" })
      .expect(201);
    expect((await cash()).expectedMinor).toBe("780000");
    await request(http).post(`/api/v1/money/expenses/${lunch.body.data.expense.id}/void`).set(auth(cashier)).send({ reason: "No" }).expect(403);
    const rejected = await request(http)
      .post(`/api/v1/money/expenses/${lunch.body.data.expense.id}/void`)
      .set(auth(owner))
      .send({ reason: "No receipt for this" })
      .expect(200);
    expect(rejected.body.data.expense).toMatchObject({ status: "voided", voidReason: "No receipt for this", canCancel: false });
    expect((await cash()).expectedMinor).toBe("850000");
  });

  it("records the owner's money and cash taken to the bank", async () => {
    await request(http).post("/api/v1/money/movements").set(auth(manager)).send({ kind: "owner_out", amountMinor: "200000", note: "School fees" }).expect(201);
    const banked = await request(http).post("/api/v1/money/movements").set(auth(manager)).send({ kind: "to_bank", amountMinor: "300000" }).expect(201);
    const shop = await cash();
    expect(shop.expectedMinor).toBe("350000");
    expect(flow(shop, "owner")).toMatchObject({ outMinor: "200000" });
    expect(flow(shop, "bank")).toMatchObject({ outMinor: "300000" });
    await request(http).post(`/api/v1/money/movements/${banked.body.data.movement.id}/void`).set(auth(manager)).send({ reason: "Wrong amount" }).expect(403);
    await request(http).post(`/api/v1/money/movements/${banked.body.data.movement.id}/void`).set(auth(owner)).send({ reason: "Wrong amount" }).expect(200);
    expect((await cash()).expectedMinor).toBe("650000");
    await request(http).post("/api/v1/money/movements").set(auth(manager)).send({ kind: "to_bank", amountMinor: "300000" }).expect(201);
    expect((await cash()).expectedMinor).toBe("350000");
  });

  it("a cashier counts the drawer without being told what was expected; the owner sees the shortage", async () => {
    await request(http).get("/api/v1/money/cash").set(auth(cashier)).expect(403);
    const counted = await request(http).post("/api/v1/money/cash-counts").set(auth(cashier)).send({ countedMinor: "300000" }).expect(201);
    expect(counted.body.data.count.countedMinor).toBe("300000");
    expect(counted.body.data.count).not.toHaveProperty("expectedMinor");
    expect(counted.body.data.count).not.toHaveProperty("differenceMinor");
    const shop = await cash();
    expect(shop.counts[0]).toMatchObject({ countedMinor: "300000", expectedMinor: "350000", differenceMinor: "-50000" });
    // The drawer now starts again from what was counted.
    expect(shop.expectedMinor).toBe("300000");
    expect(flow(shop, "counts")).toMatchObject({ outMinor: "50000" });
    // Counting more than expected is recorded too.
    const over = await request(http).post("/api/v1/money/cash-counts").set(auth(manager)).send({ countedMinor: "310000" }).expect(201);
    expect(over.body.data.count).toMatchObject({ expectedMinor: "300000", differenceMinor: "10000" });
    expect((await cash()).expectedMinor).toBe("310000");
  });

  it("works out the day's profit from the books", async () => {
    await request(http).get("/api/v1/money/profit").set(auth(cashier)).expect(403);
    const profit = await request(http).get("/api/v1/money/profit").set(auth(accountant)).expect(200);
    const data = profit.body.data;
    expect(data).toMatchObject({
      from: today,
      to: today,
      salesMinor: "1000000",
      discountsMinor: "0",
      netSalesMinor: "1000000",
      costOfSalesMinor: "600000",
      grossProfitMinor: "400000",
      posCashoutFeesMinor: "0",
      // Transport 1,500 + rent 20,000 + phone 500 + cash short 500. Cash over is not profit (ADR-038).
      expensesMinor: String(150000 + 2000000 + 50000 + 50000),
      notFromSalesMinor: "10000",
      expensesAwaitingApproval: 0,
    });
    expect(BigInt(data.profitMinor)).toBe(400000n - 2250000n);
    expect(data.expenses[0]).toMatchObject({ name: "Rent", amountMinor: "2000000" });
    expect(data.days).toHaveLength(1);
    expect(data.days[0]).toMatchObject({ date: today, profitMinor: data.profitMinor });
    const month = await request(http).get(`/api/v1/money/profit?from=${today.slice(0, 8)}01&to=${today}`).set(auth(owner)).expect(200);
    expect(month.body.data.profitMinor).toBe(data.profitMinor);
    await request(http).get(`/api/v1/money/profit?from=2020-01-01&to=${today}`).set(auth(owner)).expect(400);
  });

  it("lists the expenses with totals by category, and keeps the books balanced", async () => {
    const list = await request(http).get("/api/v1/money/expenses").set(auth(accountant)).expect(200);
    expect(list.body.data.totalMinor).toBe(String(150000 + 2000000 + 50000));
    expect(list.body.data.byCategory[0]).toMatchObject({ name: "Rent", amountMinor: "2000000" });
    expect(list.body.data.items).toHaveLength(4);
    const balance = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    expect(balance.body.data.balanced).toBe(true);
    expect(balance.body.data.totalDebitMinor).toBe(balance.body.data.totalCreditMinor);
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
