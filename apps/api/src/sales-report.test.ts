import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@bizora/contracts";
import { createApp } from "./bootstrap.js";
import { periodRange } from "./modules/sales/sales-report.service.js";
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

describe("ADR-058: periods for the sales report", () => {
  it("runs a week Monday to Sunday, and a month and a year from the first day to the last", () => {
    expect(periodRange("week", "2026-11-26")).toEqual({ from: "2026-11-23", to: "2026-11-29", previous: { from: "2026-11-16", to: "2026-11-22" } });
    expect(periodRange("week", "2026-11-29")).toMatchObject({ from: "2026-11-23", to: "2026-11-29" });
    expect(periodRange("month", "2026-03-15")).toEqual({ from: "2026-03-01", to: "2026-03-31", previous: { from: "2026-02-01", to: "2026-02-28" } });
    expect(periodRange("month", "2026-01-31")).toMatchObject({ previous: { from: "2025-12-01", to: "2025-12-31" } });
    expect(periodRange("year", "2028-02-29")).toEqual({ from: "2028-01-01", to: "2028-12-31", previous: { from: "2027-01-01", to: "2027-12-31" } });
  });
});

describe("ADR-058: sales by week, month and year", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let otherOwner = "";
  let secondShopManager = "";
  let riceId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const today = lagosDay(new Date());
  const yesterday = addDays(today, -1);
  const report = async (token: string, query: Record<string, string>) => (await request(http).get("/api/v1/sales/report").query(query).set(auth(token)).expect(200)).body.data;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@report.test", password, displayName: "Bisi Owner", organizationName: "Bisi Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Stores", branchName: "Main" })
      .expect(200);
    cashier = await invite(http, owner, "cashier@report.test", "CASHIER", branchId, businessId);
    const second = await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Second shop" }).expect(201);
    secondShopManager = await invite(http, owner, "manager2@report.test", "MANAGER", second.body.data.branch.id as string, businessId);
    const rice = await request(http).post("/api/v1/products").set(auth(owner)).send({ id: uuidv7(), name: "Rice 50kg", baseUnit: "bag", priceMinor: "8000000", openingQuantity: "50", openingCostMinor: "300000000" }).expect(201);
    riceId = rice.body.data.product.id as string;
    otherOwner = (await request(http).post("/api/v1/auth/register").send({ email: "other@report.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;

    // Today at the counter: 2 bags cash by the cashier, and 1 bag by the owner with ₦5,000 off, paid by transfer.
    await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: riceId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "16000000" }] }).expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], discountMinor: "500000", payments: [{ method: "transfer", amountMinor: "7500000" }] })
      .expect(201);
    // Offline: one sold yesterday at 12:00 Lagos time, and one at 00:30 Lagos time today (23:30 UTC yesterday).
    // Between midnight and 00:30 in Lagos, 00:30 is still to come and a sale cannot be dated in the future: use a
    // moment just past midnight instead, which is still early today.
    const earlyToday = new Date(Math.min(Date.now() - 10_000, Date.parse(`${yesterday}T23:30:00.000Z`))).toISOString();
    const offline = (soldAt: string) => ({
      id: uuidv7(),
      type: "sale.create",
      occurredAt: soldAt,
      payload: { id: uuidv7(), soldAt, lines: [{ productId: riceId, quantity: "1", unit: "bag", unitPriceMinor: "8000000" }], payments: [{ method: "cash", amountMinor: "8000000" }] },
    });
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(cashier))
      .send({ operations: [offline(`${yesterday}T11:00:00.000Z`), offline(earlyToday)] })
      .expect(200);
    expect(pushed.body.data.results.map((result: { status: string }) => result.status)).toEqual(["applied", "applied"]);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("matches Money › Profit to the kobo for the month, and splits by day in the business's time zone", async () => {
    const month = await report(owner, { period: "month", date: today });
    const range = periodRange("month", today);
    const profit = (await request(http).get("/api/v1/money/profit").query({ from: range.from, to: range.to }).set(auth(owner)).expect(200)).body.data;
    expect(month).toMatchObject({ salesMinor: profit.salesMinor, discountsMinor: profit.discountsMinor, returnsMinor: profit.returnsMinor, netSalesMinor: profit.netSalesMinor });
    // 5 bags at ₦80,000, less ₦5,000 off.
    if (yesterday.slice(0, 7) === today.slice(0, 7)) {
      expect(month).toMatchObject({ salesMinor: "40000000", discountsMinor: "500000", netSalesMinor: "39500000", salesCount: 4, averageSaleMinor: "9875000" });
    }
    const byDay = new Map((month.series as { label: string; netSalesMinor: string }[]).map((point) => [point.label, point.netSalesMinor]));
    expect(byDay.get(today)).toBe("31500000");
    if (yesterday.slice(0, 7) === today.slice(0, 7)) expect(byDay.get(yesterday)).toBe("8000000");
    expect(month.series).toHaveLength(Number(range.to.slice(8, 10)));
    expect(month.payments).toEqual(expect.arrayContaining([{ method: "cash", amountMinor: "32000000" }, { method: "transfer", amountMinor: "7500000" }]));
    expect(month.stillOwedMinor).toBe("0");
    expect(month.topItems[0]).toMatchObject({ name: "Rice 50kg", unit: "bag", quantity: "5000", costKnown: true });
    expect(month.byShop).toEqual([expect.objectContaining({ name: "Main", netSalesMinor: "39500000" })]);
    expect(month.byStaff.map((row: { name: string; salesCount: number }) => [row.name, row.salesCount])).toEqual(
      expect.arrayContaining([
        ["cashier@report.test", 3],
        ["Bisi Owner", 1],
      ]),
    );
  });

  it("gives a year by month, and a week with the week before", async () => {
    const year = await report(owner, { period: "year", date: today });
    expect(year.series).toHaveLength(12);
    const thisMonth = (year.series as { label: string; netSalesMinor: string }[]).find((point) => point.label === today.slice(0, 7));
    const month = await report(owner, { period: "month", date: today });
    expect(thisMonth?.netSalesMinor).toBe(month.netSalesMinor);
    const week = await report(owner, { period: "week", date: today });
    expect(week.series).toHaveLength(7);
    expect(week.previous.netSalesMinor).toBeDefined();
    expect(week.from <= today && today <= week.to).toBe(true);
  });

  it("shows a shop's manager only their shop, with no split by shop or person", async () => {
    const theirs = await report(secondShopManager, { period: "month", date: today });
    expect(theirs).toMatchObject({ netSalesMinor: "0", salesCount: 0, byShop: null, byStaff: null });
  });

  it("refuses staff without reports and keeps other businesses out", async () => {
    await request(http).get("/api/v1/sales/report").set(auth(cashier)).expect(403);
    const branches = (await request(http).get("/api/v1/branches").set(auth(owner)).expect(200)).body.data;
    const shopId = (branches.items ?? branches.branches ?? branches)[0].id as string;
    await request(http).get("/api/v1/sales/report").query({ branchId: shopId }).set(auth(otherOwner)).expect(404);
    const theirs = await report(otherOwner, { period: "month" });
    expect(theirs).toMatchObject({ netSalesMinor: "0", salesCount: 0, topItems: [] });
    await request(http).get("/api/v1/sales/report").query({ period: "decade" }).set(auth(owner)).expect(400);
  });

  it("downloads the report as a spreadsheet", async () => {
    const file = await request(http).get("/api/v1/sales/report.csv").query({ period: "month", date: today }).set(auth(owner)).expect(200);
    expect(file.headers["content-type"]).toContain("text/csv");
    expect(file.headers["content-disposition"]).toContain(`bizora-sales-month-${today.slice(0, 7)}-01.csv`);
    expect(file.text).toContain("Number of sales,4");
    expect(file.text).toContain("Rice 50kg,bag");
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
