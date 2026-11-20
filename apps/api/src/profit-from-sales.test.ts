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

describe("ADR-038: profit comes only from sales, and POS cash-outs", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let accountant = "";
  let storeKeeper = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const cash = async () => (await request(http).get("/api/v1/money/cash").set(auth(owner)).expect(200)).body.data.shops[0] as {
    expectedMinor: string;
    flows: { kind: string; inMinor: string; outMinor: string }[];
  };
  const profit = async () => (await request(http).get("/api/v1/money/profit").set(auth(owner)).expect(200)).body.data as Record<string, string>;
  const accountBalance = async (code: string) => {
    const accounts = (await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200)).body.data.accounts as { code: string; debitMinor: string; creditMinor: string }[];
    const row = accounts.find((account) => account.code === code);
    return row ? BigInt(row.debitMinor) - BigInt(row.creditMinor) : 0n;
  };

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@pos.test", password, displayName: "Bisi Owner", organizationName: "Bisi Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Stores", branchName: "Main" })
      .expect(200);
    cashier = await invite(http, owner, "cashier@pos.test", "CASHIER", branchId, businessId);
    accountant = await invite(http, owner, "accounts@pos.test", "ACCOUNTANT", branchId, businessId);
    storeKeeper = await invite(http, owner, "store@pos.test", "INVENTORY", branchId, businessId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("does not count the cash already in the drawer as profit on the first count", async () => {
    await request(http).post("/api/v1/money/cash-counts").set(auth(cashier)).send({ countedMinor: "5000000" }).expect(201);
    expect((await cash()).expectedMinor).toBe("5000000");
    const result = await profit();
    expect(result).toMatchObject({ profitMinor: "0", expensesMinor: "0", notFromSalesMinor: "5000000" });
    expect(await accountBalance("2190")).toBe(-5_000_000n);
  });

  it("does not count other money in as profit either", async () => {
    await request(http).post("/api/v1/money/movements").set(auth(accountant)).send({ kind: "other_in", amountMinor: "100000", note: "Loan from Ada" }).expect(201);
    expect(await profit()).toMatchObject({ profitMinor: "0", notFromSalesMinor: "5100000" });
    // POS cash-outs have their own screen and route.
    await request(http).post("/api/v1/money/movements").set(auth(owner)).send({ kind: "pos_cashout", amountMinor: "100000" }).expect(400);
  });

  it("records a POS cash-out with the fee added on the POS: the fee is profit, the cash moves to POS money", async () => {
    const before = await accountBalance("1150");
    const saved = await request(http).post("/api/v1/money/pos-cashouts").set(auth(cashier)).send({ amountMinor: "2000000", feeMinor: "20000", feePaidBy: "pos" }).expect(201);
    expect(saved.body.data.movement).toMatchObject({ kind: "pos_cashout", amountMinor: "2000000", feeMinor: "20000", feePaidBy: "pos" });
    const drawer = await cash();
    expect(drawer.expectedMinor).toBe(String(5_100_000 - 2_000_000));
    expect(drawer.flows.find((line) => line.kind === "pos_cashout")).toMatchObject({ inMinor: "0", outMinor: "2000000" });
    expect((await accountBalance("1150")) - before).toBe(2_020_000n);
    expect(await profit()).toMatchObject({ posCashoutFeesMinor: "20000", profitMinor: "20000" });
  });

  it("records a POS cash-out with the fee paid in cash", async () => {
    await request(http).post("/api/v1/money/pos-cashouts").set(auth(cashier)).send({ amountMinor: "1000000", feeMinor: "10000", feePaidBy: "cash" }).expect(201);
    expect((await cash()).expectedMinor).toBe(String(3_100_000 - 1_000_000 + 10_000));
    expect(await profit()).toMatchObject({ posCashoutFeesMinor: "30000", profitMinor: "30000" });
    const balance = (await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200)).body.data;
    expect(balance.balanced).toBe(true);
  });

  it("checks the amounts and who records cash-outs", async () => {
    await request(http).post("/api/v1/money/pos-cashouts").set(auth(cashier)).send({ amountMinor: "1000", feeMinor: "5000" }).expect(400);
    await request(http).post("/api/v1/money/pos-cashouts").set(auth(cashier)).send({ amountMinor: "0" }).expect(400);
    await request(http).post("/api/v1/money/pos-cashouts").set(auth(storeKeeper)).send({ amountMinor: "1000" }).expect(403);
    await request(http).post("/api/v1/money/pos-cashouts").set(auth(accountant)).send({ amountMinor: "1000" }).expect(403);
    const free = await request(http).post("/api/v1/money/pos-cashouts").set(auth(owner)).send({ amountMinor: "500000" }).expect(201);
    expect(free.body.data.movement).toMatchObject({ feeMinor: "0", feePaidBy: "pos" });
    // The owner cancels it: the drawer and profit go back.
    await request(http).post(`/api/v1/money/movements/${free.body.data.movement.id}/void`).set(auth(owner)).send({ reason: "Customer's card was declined" }).expect(200);
    expect((await cash()).expectedMinor).toBe("2110000");
  });

  it("still counts cash short as a cost", async () => {
    await request(http).post("/api/v1/money/cash-counts").set(auth(cashier)).send({ countedMinor: "2100000" }).expect(201);
    expect(await profit()).toMatchObject({ expensesMinor: "10000", profitMinor: String(30_000 - 10_000) });
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
