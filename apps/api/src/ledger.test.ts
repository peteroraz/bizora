import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { ChartOfAccountsService } from "./modules/ledger/chart-of-accounts.service.js";
import { LedgerPostingService, type PostingRequest } from "./modules/ledger/ledger-posting.service.js";
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

describe("accounting core", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let chart: ChartOfAccountsService;
  let salesToken = "";
  let accountantToken = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const actorA = () => ({ tenantId: a.tenantId, userId: null });

  const cashSale = (key: string, amount: bigint, date = "2026-11-15"): PostingRequest => ({
    businessId: a.businessId,
    branchId: a.branchId,
    entryDate: date,
    source: { type: "sale", id: uuidv7() },
    postingKey: key,
    description: "Cash sale",
    lines: [
      { account: { role: "cash" }, debitMinor: amount },
      { account: { role: "sales" }, creditMinor: amount },
    ],
  });

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b", "professional-services");
    ledger = app.get(LedgerPostingService);
    chart = app.get(ChartOfAccountsService);
    salesToken = await invite(http, a.token, "sales@ledger.test", "SALES", a.branchId, a.businessId);
    accountantToken = await invite(http, a.token, "accounts@ledger.test", "ACCOUNTANT", a.branchId, a.businessId);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("creates the chart of accounts for the business type, with cash per shop, only once", async () => {
    const shop = await chart.list(a.tenantId, a.businessId);
    const roles = shop.map((account) => account.role);
    expect(roles).toEqual(expect.arrayContaining(["cash", "bank", "debtors", "stock", "sales", "cogs", "payable", "capital"]));
    expect(shop.filter((account) => account.role === "cash").map((account) => [account.code, account.branchId])).toEqual([["1000-01", a.branchId]]);
    expect(await db.transaction((tx) => chart.ensure(tx, a.tenantId, a.businessId))).toBe(0);

    const second = await request(app.getHttpServer()).post("/api/v1/branches").set(auth(a.token)).send({ name: "Second shop" }).expect(201);
    expect(await db.transaction((tx) => chart.ensure(tx, a.tenantId, a.businessId))).toBe(1);
    const cash = (await chart.list(a.tenantId, a.businessId)).filter((account) => account.role === "cash");
    expect(cash.map((account) => account.code)).toEqual(["1000-01", "1000-02"]);
    expect(cash[1]?.branchId).toBe(second.body.data.branch.id);

    const services = await chart.list(b.tenantId, b.businessId);
    expect(services.some((account) => account.role === "stock" || account.role === "cogs")).toBe(false);
    expect(services.some((account) => account.role === "service_income")).toBe(true);
  });

  it("posts balanced entries once per posting key and keeps the trial balance balanced", async () => {
    const first = await db.transaction((tx) => ledger.post(tx, actorA(), cashSale("sale:1", 5_000_00n)));
    expect(first.created).toBe(true);
    const retry = await db.transaction((tx) => ledger.post(tx, actorA(), { ...cashSale("sale:1", 5_000_00n), source: { type: "sale", id: uuidv7() } })).catch((error: { code?: string }) => error);
    expect((retry as { code?: string }).code).toBe("POSTING_KEY_CONFLICT");
    const request1 = cashSale("sale:2", 2_500_00n);
    const created = await db.transaction((tx) => ledger.post(tx, actorA(), request1));
    const again = await db.transaction((tx) => ledger.post(tx, actorA(), request1));
    expect(again).toEqual({ entryId: created.entryId, created: false });

    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(trial.totalDebitMinor).toBe(7_500_00n);
    expect(trial.accounts.find((row) => row.code === "1000-01")?.balanceMinor).toBe(7_500_00n);
    expect(trial.accounts.find((row) => row.code === "4000")?.balanceMinor).toBe(-7_500_00n);
  });

  it("refuses unbalanced, one-sided, ambiguous and unknown lines", async () => {
    const attempt = (request: PostingRequest) => db.transaction((tx) => ledger.post(tx, actorA(), request)).catch((error: { code?: string }) => error.code);
    expect(
      await attempt({ ...cashSale("bad:1", 100n), lines: [{ account: { role: "cash" }, debitMinor: 100n }, { account: { role: "sales" }, creditMinor: 90n }] }),
    ).toBe("LEDGER_UNBALANCED");
    expect(await attempt({ ...cashSale("bad:2", 100n), lines: [{ account: { role: "cash" }, debitMinor: 100n, creditMinor: 100n }, { account: { role: "sales" }, creditMinor: 0n }] })).toBe("LEDGER_INVALID");
    expect(await attempt({ ...cashSale("bad:3", 100n), lines: [{ account: { role: "expense" }, debitMinor: 100n }, { account: { role: "cash" }, creditMinor: 100n }] })).toBe("LEDGER_ACCOUNT_AMBIGUOUS");
    expect(await attempt({ ...cashSale("bad:4", 100n), lines: [{ account: { code: "9999" }, debitMinor: 100n }, { account: { role: "cash" }, creditMinor: 100n }] })).toBe("LEDGER_ACCOUNT_NOT_FOUND");
    expect(await attempt({ ...cashSale("bad:5", 100n), entryDate: "2026-02-30" })).toBe("LEDGER_INVALID");
    // An expense is posted by its category code.
    const rent = await db.transaction((tx) =>
      ledger.post(tx, actorA(), { ...cashSale("rent:1", 50_000_00n), source: { type: "expense", id: uuidv7() }, lines: [{ account: { code: "6000" }, debitMinor: 50_000_00n }, { account: { role: "cash" }, creditMinor: 50_000_00n }] }),
    );
    expect(rent.created).toBe(true);
  });

  it("never lets one organization post to another's business or accounts", async () => {
    const bAccounts = await chart.list(b.tenantId, b.businessId);
    const bBank = bAccounts.find((account) => account.role === "bank");
    const intoB = await db.transaction((tx) => ledger.post(tx, actorA(), { ...cashSale("cross:1", 100n), businessId: b.businessId })).catch((error: { code?: string }) => error.code);
    expect(intoB).toBe("NOT_FOUND");
    const withBAccount = await db
      .transaction((tx) => ledger.post(tx, actorA(), { ...cashSale("cross:2", 100n), lines: [{ account: { id: bBank?.id as string }, debitMinor: 100n }, { account: { role: "sales" }, creditMinor: 100n }] }))
      .catch((error: { code?: string }) => error.code);
    expect(withBAccount).toBe("LEDGER_ACCOUNT_NOT_FOUND");
    const trialB = await ledger.trialBalance(b.tenantId, b.businessId);
    expect(trialB.totalDebitMinor).toBe(0n);
  });

  it("records foreign currency with the trader's rate and checks the naira amount", async () => {
    const usd = { currencyCode: "USD", amountMinor: 100_00n, fxRate: "1500" };
    const ok = await db.transaction((tx) =>
      ledger.post(tx, actorA(), { ...cashSale("fx:1", 150_000_00n), lines: [{ account: { role: "bank" }, debitMinor: 150_000_00n, original: usd }, { account: { role: "sales" }, creditMinor: 150_000_00n }] }),
    );
    expect(ok.created).toBe(true);
    const [line] = (await client.query<{ original_currency_code: string; fx_rate: string }>("SELECT original_currency_code, fx_rate FROM journal_lines WHERE entry_id = $1 AND line_no = 1", [ok.entryId])).rows;
    expect(line).toEqual({ original_currency_code: "USD", fx_rate: "1500.0000000000" });
    const mismatch = await db
      .transaction((tx) => ledger.post(tx, actorA(), { ...cashSale("fx:2", 140_000_00n), lines: [{ account: { role: "bank" }, debitMinor: 140_000_00n, original: usd }, { account: { role: "sales" }, creditMinor: 140_000_00n }] }))
      .catch((error: { code?: string }) => error.code);
    expect(mismatch).toBe("LEDGER_FX_MISMATCH");
  });

  it("corrects by reversing, and the database refuses edits, deletes and unbalanced rows", async () => {
    const sale = await db.transaction((tx) => ledger.post(tx, actorA(), cashSale("sale:rev", 1_000_00n)));
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const reversal = await db.transaction((tx) => ledger.reverse(tx, actorA(), sale.entryId, { entryDate: "2026-11-16", reason: "Wrong price" }));
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    const cash = (trial: typeof after) => trial.accounts.find((row) => row.code === "1000-01")?.balanceMinor;
    expect((cash(before) ?? 0n) - (cash(after) ?? 0n)).toBe(1_000_00n);
    expect(after.balanced).toBe(true);
    const twice = await db.transaction((tx) => ledger.reverse(tx, actorA(), sale.entryId, { entryDate: "2026-11-16", reason: "Again" })).catch((error: { code?: string }) => error.code);
    expect(twice).toBe("ALREADY_REVERSED");
    expect(reversal.entryId).not.toBe(sale.entryId);

    await expect(client.query("UPDATE journal_lines SET debit_minor = 1 WHERE entry_id = $1 AND line_no = 1", [sale.entryId])).rejects.toThrow(/cannot be changed/);
    await expect(client.query("DELETE FROM journal_entries WHERE id = $1", [sale.entryId])).rejects.toThrow(/cannot be changed/);
    const accounts = await chart.list(a.tenantId, a.businessId);
    const cashId = accounts.find((account) => account.code === "1000-01")?.id;
    const salesId = accounts.find((account) => account.code === "4000")?.id;
    const entryId = uuidv7();
    await expect(
      client.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO journal_entries (id, tenant_id, business_id, entry_date, period_start, currency_code, source_type, source_id, posting_key, description) VALUES ($1, $2, $3, '2026-11-15', '2026-11-01', 'NGN', 'raw', $1, 'raw:1', 'raw')",
          [entryId, a.tenantId, a.businessId],
        );
        await tx.query(
          "INSERT INTO journal_lines (id, tenant_id, business_id, entry_id, account_id, line_no, debit_minor, credit_minor) VALUES ($1, $2, $3, $4, $5, 1, 100, 0), ($6, $2, $3, $4, $7, 2, 0, 90)",
          [uuidv7(), a.tenantId, a.businessId, entryId, cashId, uuidv7(), salesId],
        );
      }),
    ).rejects.toThrow(/not balanced/);
  });

  it("closes a month: no new entries in it, corrections go into an open month", async () => {
    const october = await db.transaction((tx) => ledger.post(tx, actorA(), cashSale("oct:1", 3_000_00n, "2026-10-20")));
    await db.transaction((tx) => ledger.lockPeriod(tx, actorA(), a.businessId, "2026-10-01"));
    const late = await db.transaction((tx) => ledger.post(tx, actorA(), cashSale("oct:2", 100n, "2026-10-25"))).catch((error: { code?: string }) => error.code);
    expect(late).toBe("PERIOD_LOCKED");
    const intoOctober = await db.transaction((tx) => ledger.reverse(tx, actorA(), october.entryId, { entryDate: "2026-10-31", reason: "Mistake" })).catch((error: { code?: string }) => error.code);
    expect(intoOctober).toBe("PERIOD_LOCKED");
    const correction = await db.transaction((tx) => ledger.reverse(tx, actorA(), october.entryId, { entryDate: "2026-11-02", reason: "Mistake" }));
    expect(correction.entryId).toBeTruthy();
    await expect(client.query("UPDATE ledger_periods SET status = 'open' WHERE tenant_id = $1 AND period_start = '2026-10-01'", [a.tenantId])).rejects.toThrow(/cannot be reopened/);

    const endOfOctober = await ledger.trialBalance(a.tenantId, a.businessId, "2026-10-31");
    expect(endOfOctober.accounts.find((row) => row.code === "1000-01")?.balanceMinor).toBe(3_000_00n);
    expect(endOfOctober.balanced).toBe(true);
  });

  it("shows the trial balance to the owner and accountant only", async () => {
    const http = app.getHttpServer();
    const owner = await request(http).get("/api/v1/ledger/trial-balance").set(auth(a.token)).expect(200);
    expect(owner.body.data.balanced).toBe(true);
    expect(owner.body.data.totalDebitMinor).toBe(owner.body.data.totalCreditMinor);
    await request(http).get("/api/v1/ledger/trial-balance").set(auth(accountantToken)).expect(200);
    await request(http).get("/api/v1/ledger/trial-balance").set(auth(salesToken)).expect(403);
    await request(http).get("/api/v1/ledger/accounts").set(auth(salesToken)).expect(403);
    const accounts = await request(http).get("/api/v1/ledger/accounts").set(auth(accountantToken)).expect(200);
    expect(accounts.body.data.items.length).toBeGreaterThan(20);
    const other = await request(http).get("/api/v1/ledger/trial-balance").set(auth(b.token)).expect(200);
    expect(other.body.data.totalDebitMinor).toBe("0");
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
