import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { ROLE_PERMISSIONS, Permission } from "@bizora/contracts";
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
};

const password = "LocalOnly!Passw0rd";
// "Today" in the shop's timezone, as Bizora counts it. UTC would be a day behind between 23:00 and midnight UTC.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("job-function access", () => {
  let app: INestApplication;
  let client: PGlite;
  let ownerToken = "";
  let managerToken = "";
  let salesToken = "";
  let cashierToken = "";
  let storekeeperToken = "";
  let accountantToken = "";
  let chikaId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();

    const owner = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "owner@access.test",
        password,
        displayName: "Ngozi Owner",
        organizationName: "Ngozi Provisions",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    ownerToken = owner.body.data.accessToken as string;
    const businessId = owner.body.data.tenant.businessId as string;
    const branchId = owner.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(ownerToken))
      .send({
        countryCode: "NG",
        industryCode: "general-retail",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        businessName: "Ngozi Provisions",
        branchName: "Main",
      })
      .expect(200);

    managerToken = await invite(http, ownerToken, "manager@access.test", "MANAGER", branchId, businessId);
    salesToken = await invite(http, ownerToken, "sales@access.test", "SALES", branchId, businessId);
    cashierToken = await invite(http, ownerToken, "cashier@access.test", "CASHIER", branchId, businessId);
    storekeeperToken = await invite(http, ownerToken, "stock@access.test", "INVENTORY", branchId, businessId);
    accountantToken = await invite(http, ownerToken, "accounts@access.test", "ACCOUNTANT", branchId, businessId);

    const chika = await request(http)
      .post("/api/v1/customers")
      .set(auth(ownerToken))
      .send({
        name: "Chika Okafor",
        phone: "08031234567",
        email: "chika@example.com",
        branchId,
        tags: ["wholesale"],
        notesSummary: "Buys rice on credit",
        address: { shopNumber: "B12", marketOrPlaza: "Main Market", city: "Onitsha", countryCode: "NG", subdivisionCode: "NG-AN" },
      })
      .expect(201);
    chikaId = chika.body.data.customer.id as string;
    for (let index = 0; index < 12; index += 1) {
      await request(http)
        .post("/api/v1/customers")
        .set(auth(ownerToken))
        .send({ name: `Bisi Trader ${index}`, phone: `0805000${String(index).padStart(4, "0")}`, branchId })
        .expect(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("stores exactly the grants in ROLE_PERMISSIONS for every role", async () => {
    const codes = await client.query<{ code: string }>("SELECT code FROM permissions");
    expect(new Set(codes.rows.map((row) => row.code))).toEqual(new Set(Object.values(Permission)));
    const grants = await client.query<{ role: string; code: string }>(
      "SELECT role_permissions.role, permissions.code FROM role_permissions JOIN permissions ON permissions.id = role_permissions.permission_id",
    );
    for (const [role, expected] of Object.entries(ROLE_PERMISSIONS)) {
      const stored = grants.rows.filter((row) => row.role === role).map((row) => row.code);
      expect({ role, codes: [...stored].sort() }).toEqual({ role, codes: [...new Set(expected)].sort() });
    }
  });

  it("keeps separation of duties in the matrix", () => {
    const has = (role: keyof typeof ROLE_PERMISSIONS, code: string) => ROLE_PERMISSIONS[role].includes(code as never);
    // Whoever takes money cannot cancel sales or see the expected cash in the drawer.
    expect(has("CASHIER", Permission.PAYMENTS_RECORD)).toBe(true);
    expect(has("CASHIER", Permission.SALES_VOID)).toBe(false);
    expect(has("CASHIER", Permission.CASH_EXPECTED_READ)).toBe(false);
    // Whoever receives stock cannot adjust it or order from suppliers.
    expect(has("INVENTORY", Permission.STOCK_RECEIVE)).toBe(true);
    expect(has("INVENTORY", Permission.STOCK_ADJUST)).toBe(false);
    expect(has("INVENTORY", Permission.PURCHASES_MANAGE)).toBe(false);
    // The accountant checks the figures without taking sales or payments.
    expect(has("ACCOUNTANT", Permission.SALES_CREATE)).toBe(false);
    expect(has("ACCOUNTANT", Permission.PAYMENTS_RECORD)).toBe(false);
    // Recording an expense and approving it are different people.
    expect(has("MANAGER", Permission.EXPENSES_RECORD)).toBe(true);
    expect(has("MANAGER", Permission.EXPENSES_APPROVE)).toBe(false);
    // Sales staff do not see money, debtors, costs or profit; storekeepers see no customers.
    for (const code of [Permission.MONEY_READ, Permission.DEBTORS_READ, Permission.PRICES_COST_READ, Permission.REPORTS_PROFIT_READ]) {
      expect(has("SALES", code)).toBe(false);
    }
    expect(has("INVENTORY", Permission.CUSTOMERS_READ)).toBe(false);
    expect(has("INVENTORY", Permission.CUSTOMERS_LOOKUP)).toBe(false);
  });

  it("lets a cashier find one customer at the counter, but never list them all", async () => {
    const http = app.getHttpServer();
    const me = await request(http).get("/api/v1/auth/me").set(auth(cashierToken)).expect(200);
    expect(me.body.data.tenant.permissions).toContain("customers.lookup");
    expect(me.body.data.tenant.permissions).not.toContain("customers.read");

    for (const q of ["", "ch", "0803", "803 12"]) {
      const short = await request(http).get("/api/v1/customers").query({ q }).set(auth(cashierToken)).expect(400);
      expect(short.body.error.code).toBe("SEARCH_TOO_SHORT");
    }

    const byName = await request(http).get("/api/v1/customers").query({ q: "chika" }).set(auth(cashierToken)).expect(200);
    expect(byName.body.data.mode).toBe("lookup");
    expect(byName.body.data.items).toEqual([{ id: chikaId, name: "Chika Okafor", isWalkIn: false, phoneLast4: "4567", credit: { allowed: false, limitMinor: null }, limited: true }]);

    for (const q of ["0803 123 4567", "+2348031234567", "1234567"]) {
      const byPhone = await request(http).get("/api/v1/customers").query({ q }).set(auth(cashierToken)).expect(200);
      expect(byPhone.body.data.items.map((item: { id: string }) => item.id)).toEqual([chikaId]);
    }

    const many = await request(http).get("/api/v1/customers").query({ q: "Bisi" }).set(auth(cashierToken)).expect(200);
    expect(many.body.data.items).toHaveLength(10);

    const detail = await request(http).get(`/api/v1/customers/${chikaId}`).set(auth(cashierToken)).expect(200);
    expect(detail.body.data.customer).toEqual({ id: chikaId, name: "Chika Okafor", isWalkIn: false, phoneLast4: "4567", credit: { allowed: false, limitMinor: null }, owingMinor: "0", limited: true });

    await request(http).get(`/api/v1/customers/${chikaId}/notes`).set(auth(cashierToken)).expect(403);
    await request(http).get(`/api/v1/customers/${chikaId}/followups`).set(auth(cashierToken)).expect(403);
    await request(http).get("/api/v1/followups").set(auth(cashierToken)).expect(403);
    await request(http).get("/api/v1/customers/assignees").set(auth(cashierToken)).expect(403);
    // A cashier may add a walk-in customer at the counter (ADR-019), but not change existing customers.
    await request(http).post("/api/v1/customers").set(auth(cashierToken)).send({ name: "New", isWalkIn: true }).expect(201);
    await request(http).patch(`/api/v1/customers/${chikaId}`).set(auth(cashierToken)).send({ name: "Changed" }).expect(403);
  });

  it("gives a storekeeper no customer data at all", async () => {
    const http = app.getHttpServer();
    await request(http).get("/api/v1/customers").query({ q: "Chika" }).set(auth(storekeeperToken)).expect(403);
    await request(http).get(`/api/v1/customers/${chikaId}`).set(auth(storekeeperToken)).expect(403);
    await request(http).get("/api/v1/followups").set(auth(storekeeperToken)).expect(403);
    const home = await request(http).get("/api/v1/dashboard").set(auth(storekeeperToken)).expect(200);
    expect(home.body.data.customerCount).toBe(0);
    expect(home.body.data.followupsDueToday).toEqual([]);
    expect(home.body.data.checklist).toEqual([]);
  });

  it("shows sales staff only their own follow-ups, and managers all of them", async () => {
    const http = app.getHttpServer();
    const ownerFollowup = await request(http)
      .post(`/api/v1/customers/${chikaId}/followups`)
      .set(auth(ownerToken))
      .send({ reason: "Owner: collect balance", dueOn: today })
      .expect(201);
    await request(http)
      .post(`/api/v1/customers/${chikaId}/followups`)
      .set(auth(salesToken))
      .send({ reason: "Sales: offer new stock", dueOn: today })
      .expect(201);

    const salesView = await request(http).get("/api/v1/followups").query({ bucket: "today" }).set(auth(salesToken)).expect(200);
    expect(salesView.body.data.items.map((item: { reason: string }) => item.reason)).toEqual(["Sales: offer new stock"]);
    const salesCustomer = await request(http).get(`/api/v1/customers/${chikaId}/followups`).set(auth(salesToken)).expect(200);
    expect(salesCustomer.body.data.items).toHaveLength(1);
    const salesHome = await request(http).get("/api/v1/dashboard").set(auth(salesToken)).expect(200);
    expect(salesHome.body.data.followupsDueToday).toHaveLength(1);
    await request(http)
      .patch(`/api/v1/followups/${ownerFollowup.body.data.followup.id}`)
      .set(auth(salesToken))
      .send({ status: "done" })
      .expect(404);

    const managerView = await request(http).get("/api/v1/followups").query({ bucket: "today" }).set(auth(managerToken)).expect(200);
    expect(managerView.body.data.items).toHaveLength(2);

    // Sales staff still work the full customer list.
    const list = await request(http).get("/api/v1/customers").set(auth(salesToken)).expect(200);
    expect(list.body.data.mode).toBe("list");
    expect(list.body.data.total).toBe(14);
    expect(list.body.data.items[0]).toHaveProperty("email");
  });

  it("lets the accountant read customers without changing them", async () => {
    const http = app.getHttpServer();
    const list = await request(http).get("/api/v1/customers").set(auth(accountantToken)).expect(200);
    expect(list.body.data.mode).toBe("list");
    const detail = await request(http).get(`/api/v1/customers/${chikaId}`).set(auth(accountantToken)).expect(200);
    expect(detail.body.data.customer.email).toBe("chika@example.com");
    await request(http).post("/api/v1/customers").set(auth(accountantToken)).send({ name: "New", isWalkIn: true }).expect(403);
  });

  it("shows the setup checklist only to people who set up the shop", async () => {
    const http = app.getHttpServer();
    const ownerHome = await request(http).get("/api/v1/dashboard").set(auth(ownerToken)).expect(200);
    expect(ownerHome.body.data.checklist.map((item: { id: string }) => item.id)).toEqual([
      "shop-place",
      "first-customer",
      "what-you-sell",
      "invite-staff",
      "record-sale",
    ]);
    for (const token of [managerToken, salesToken, cashierToken, accountantToken]) {
      const home = await request(http).get("/api/v1/dashboard").set(auth(token)).expect(200);
      expect(home.body.data.checklist).toEqual([]);
    }
    const cashierHome = await request(http).get("/api/v1/dashboard").set(auth(cashierToken)).expect(200);
    expect(cashierHome.body.data.customerCount).toBe(0);
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
