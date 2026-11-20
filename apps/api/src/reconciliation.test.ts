import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { LedgerPostingService } from "./modules/ledger/ledger-posting.service.js";
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
      email: `owner.${label}@bank.test`,
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

describe("bank statements and the reconciliation inbox", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let accountantToken = "";
  let cashierToken = "";
  let chikaId = "";
  let chikaLineId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  const today = `${d}/${m}/${y}`;
  const row = (description: string, moneyIn: string, reference = "", moneyOut = "", date = today) => ({ date, description, reference, moneyIn, moneyOut });
  const owing = async () => (await request(app.getHttpServer()).get(`/api/v1/debtors/${chikaId}`).set(auth(a.token)).expect(200)).body.data.account.owingMinor as string;
  const inbox = async (status = "open") => (await request(app.getHttpServer()).get("/api/v1/reconciliation").query({ status }).set(auth(a.token)).expect(200)).body.data;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    ledger = app.get(LedgerPostingService);
    accountantToken = await invite(http, a.token, "accountant@bank.test", "ACCOUNTANT", a.branchId, a.businessId);
    cashierToken = await invite(http, a.token, "cashier@bank.test", "CASHIER", a.branchId, a.businessId);
    const milk = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "100", openingCostMinor: "3500000" }).expect(201);
    const milkId = milk.body.data.product.id as string;
    const chika = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201);
    chikaId = chika.body.data.customer.id;
    // Chika owes ₦20,000. Another customer paid ₦4,500 by transfer at the counter, reference GTB12345.
    await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ lines: [{ productId: milkId, quantity: "44", unit: "tin" }, { productId: milkId, quantity: "1", unit: "tin", unitPriceMinor: "20000" }], customerId: chikaId, payments: [], dueDate: "2099-01-31", comment: "Pays weekly" })
      .expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ lines: [{ productId: milkId, quantity: "10", unit: "tin" }], payments: [{ method: "transfer", amountMinor: "450000", reference: "GTB12345" }] })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("checks a statement, skips money out and lines seen before, and matches recorded transfers by reference", async () => {
    const http = app.getHttpServer();
    expect(await owing()).toBe("2000000");
    const rows = [
      row("NIP CR/MAMA CHIKA/GTB/rice", "15,000.00", "S1"),
      row("TRF FRM BOLA ADE REF GTB12345", "4,500.00", "S2"),
      row("POS SETTLEMENT MONIEPOINT 0012", "25000", "S3"),
      row("ATM WITHDRAWAL", "", "S4", "3,000.00"),
      row("Somebody", "1000", "S5", "", "not a date"),
    ];
    const checked = await request(http).post("/api/v1/imports/statement").set(auth(a.token)).send({ accountLabel: "GTBank 0123", rows }).expect(200);
    expect(checked.body.data.results.map((result: { status: string }) => result.status)).toEqual(["create", "create", "create", "skip", "error"]);
    expect(checked.body.data.results[4].errors[0].field).toBe("date");
    const saved = await request(http).post("/api/v1/imports/statement").set(auth(a.token)).send({ accountLabel: "GTBank 0123", rows: rows.slice(0, 4), dryRun: false }).expect(200);
    expect(saved.body.data).toMatchObject({ committed: true, autoMatched: 1, totals: { create: 3 } });
    // The same statement again: nothing new.
    const again = await request(http).post("/api/v1/imports/statement").set(auth(a.token)).send({ accountLabel: "GTBank 0123", rows: rows.slice(0, 4), dryRun: false }).expect(200);
    expect(again.body.data.results.map((result: { message: string }) => result.message)).toEqual([
      "Already imported from an earlier statement.",
      "Already imported from an earlier statement.",
      "Already imported from an earlier statement.",
      "Money out: matching comes with money in and out (Sprint 7).",
    ]);
    const done = await inbox("done");
    expect(done.items[0]).toMatchObject({ amountMinor: "450000", status: "matched", matchKind: "recorded_payment", autoMatched: true });
    const open = await inbox();
    expect(open.counts).toMatchObject({ open: 2, matched: 1, openMinor: "4000000" });
    const counts = await request(http).get("/api/v1/reconciliation/counts").set(auth(a.token)).expect(200);
    expect(counts.body.data).toMatchObject({ open: 2, openMinor: "4000000" });
    const chikaLine = open.items.find((item: { description: string }) => item.description.includes("CHIKA"));
    chikaLineId = chikaLine.id;
    expect(chikaLine.suggestions[0]).toMatchObject({ confidence: "likely", target: { kind: "debtor", customerId: chikaId }, detail: { customerName: "Mama Chika", owingMinor: "2000000" } });
  });

  it("records a debtor's transfer as their payment, and POS settlements as money moving, not income", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const matched = await request(http).post(`/api/v1/reconciliation/${chikaLineId}/match`).set(auth(accountantToken)).send({ target: { kind: "debtor", customerId: chikaId } }).expect(200);
    expect(matched.body.data.line).toMatchObject({ status: "matched", matchKind: "debtor", matchDetail: "debt", customerName: "Mama Chika", paymentNumber: "PAY-000001" });
    expect(await owing()).toBe("500000");
    await request(http).post(`/api/v1/reconciliation/${chikaLineId}/match`).set(auth(a.token)).send({ target: { kind: "ignored", reason: "x" } }).expect(409);

    const pos = (await inbox()).items[0];
    await request(http)
      .post(`/api/v1/reconciliation/${pos.id}/match`)
      .set(auth(a.token))
      .send({ target: { kind: "own_transfer", source: "pos_settlement" }, rulePattern: "pos settlement" })
      .expect(200);
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(after.accounts, "1100") - balance(before.accounts, "1100")).toBe(4_000_000n);
    expect(balance(before.accounts, "1200") - balance(after.accounts, "1200")).toBe(1_500_000n);
    expect(balance(before.accounts, "1150") - balance(after.accounts, "1150")).toBe(2_500_000n);
    // Income did not change.
    expect(balance(after.accounts, "4000")).toBe(balance(before.accounts, "4000"));
    const rules = await request(http).get("/api/v1/reconciliation/rules").set(auth(a.token)).expect(200);
    expect(rules.body.data.items[0]).toMatchObject({ pattern: "POS SETTLEMENT", target: { kind: "own_transfer", source: "pos_settlement" }, timesUsed: 1 });
  });

  it("applies saved rules to the next statement, and keeps money above a debt as an advance", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const saved = await request(http)
      .post("/api/v1/imports/statement")
      .set(auth(a.token))
      .send({ accountLabel: "GTBank 0123", dryRun: false, rows: [row("POS SETTLEMENT MONIEPOINT 0013", "12000", "S6"), row("TRANSFER FROM MAMA CHIKA", "10000", "S7")] })
      .expect(200);
    expect(saved.body.data.autoMatched).toBe(1);
    const line = (await inbox()).items[0];
    const matched = await request(http).post(`/api/v1/reconciliation/${line.id}/match`).set(auth(a.token)).send({ target: { kind: "debtor", customerId: chikaId } }).expect(200);
    // She owed ₦5,000: that is paid, and ₦5,000 is kept as her advance.
    expect(matched.body.data.line.matchDetail).toBe("debt_and_advance");
    expect(await owing()).toBe("0");
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(after.accounts, "2100") - balance(before.accounts, "2100")).toBe(-500_000n);
  });

  it("undoes a match: the payment is cancelled and the line goes back to the inbox", async () => {
    const http = app.getHttpServer();
    const undone = await request(http).post(`/api/v1/reconciliation/${chikaLineId}/undo`).set(auth(a.token)).expect(200);
    expect(undone.body.data.line).toMatchObject({ status: "open", matchKind: null });
    expect(undone.body.data.line.suggestions.length).toBeGreaterThan(0);
    expect(await owing()).toBe("1500000");
    const payment = await client.query<{ status: string }>("SELECT status FROM customer_payments WHERE tenant_id = $1 AND payment_number = 'PAY-000001'", [a.tenantId]);
    expect(payment.rows[0]?.status).toBe("voided");
    // Classified another way instead: other money in, which is not a sale and so not profit (ADR-038).
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    await request(http).post(`/api/v1/reconciliation/${chikaLineId}/match`).set(auth(a.token)).send({ target: { kind: "money_in", category: "other_income" } }).expect(200);
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(balance(after.accounts, "2190") - balance(before.accounts, "2190")).toBe(-1_500_000n);
    expect(after.balanced).toBe(true);
  });

  it("is for owners and accountants only, and keeps each organization's statements to itself", async () => {
    const http = app.getHttpServer();
    await request(http).get("/api/v1/reconciliation").set(auth(cashierToken)).expect(403);
    await request(http).post("/api/v1/imports/statement").set(auth(cashierToken)).send({ accountLabel: "x", rows: [row("x", "1")] }).expect(403);
    const accountant = await request(http).get("/api/v1/reconciliation").query({ status: "done" }).set(auth(accountantToken)).expect(200);
    expect(accountant.body.data.counts.matched).toBeGreaterThan(0);
    const other = await request(http).get("/api/v1/reconciliation").set(auth(b.token)).expect(200);
    expect(other.body.data.counts).toMatchObject({ open: 0, matched: 0 });
    await request(http).post(`/api/v1/reconciliation/${chikaLineId}/undo`).set(auth(b.token)).expect(404);
    await request(http).post(`/api/v1/reconciliation/${chikaLineId}/match`).set(auth(b.token)).send({ target: { kind: "ignored", reason: "x" } }).expect(404);
    const customers = await request(http).get("/api/v1/reconciliation/customers").set(auth(b.token)).expect(200);
    expect(customers.body.data.items).toEqual([]);
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
