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
// "Today" in the shop's timezone, as Bizora counts it. UTC would be a day behind between 23:00 and midnight UTC.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());


describe("sprint 7e: transfers wait for confirmation, and the discounts and cancellations report", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let cashier = "";
  let accountant = "";
  let productId = "";
  let customerId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const inDays = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const balanceOf = async (code: string) => {
    const trial = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    expect(trial.body.data.balanced).toBe(true);
    return (trial.body.data.accounts.find((account: { code: string }) => account.code === code)?.balanceMinor ?? "0") as string;
  };
  const sell = async (token: string, payment: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({ lines: [{ productId, quantity: "1", unit: "piece" }], payments: [{ method: "transfer", amountMinor: "1000000", ...payment }], ...extra })
      .expect(201);
    return sale.body.data.sale as { id: string; number: string; payments: { id: string; confirmation: string }[] };
  };
  const waiting = async () => (await request(http).get("/api/v1/transfers").set(auth(accountant)).expect(200)).body.data;

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
        email: "owner@transfers.test",
        password,
        displayName: "Ngozi Owner",
        organizationName: "Ngozi Stores",
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
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ngozi Stores", branchName: "Main" })
      .expect(200);
    manager = await invite(http, owner, "manager@transfers.test", "MANAGER", branchId, businessId);
    cashier = await invite(http, owner, "cashier@transfers.test", "CASHIER", branchId, businessId);
    accountant = await invite(http, owner, "accountant@transfers.test", "ACCOUNTANT", branchId, businessId);
    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(owner))
      .send({ name: "Sneakers", baseUnit: "piece", priceMinor: "1000000", openingQuantity: "30", openingCostMinor: "18000000" })
      .expect(201);
    productId = product.body.data.product.id as string;
    const customer = await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Tunde Bello", phone: "08031234567", creditAllowed: true }).expect(201);
    customerId = customer.body.data.customer.id as string;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("holds a cashier's transfer until someone who sees the bank confirms it", async () => {
    const sale = await sell(cashier, { reference: "GTB1001" });
    expect(sale.payments[0]?.confirmation).toBe("waiting");
    expect(await balanceOf("1160")).toBe("1000000");
    expect(await balanceOf("1100")).toBe("0");
    // The owner and the accountant are told; the cashier is not.
    const told = await request(http).get("/api/v1/notifications").set(auth(owner)).expect(200);
    expect(told.body.data.items[0]).toMatchObject({ kind: "transfer.waiting", saleId: sale.id, actorName: "cashier@transfers.test" });
    // Only those who see the bank may check transfers.
    await request(http).get("/api/v1/transfers").set(auth(cashier)).expect(403);
    await request(http).get("/api/v1/transfers").set(auth(manager)).expect(403);
    const list = await waiting();
    expect(list).toMatchObject({ waitingCount: 1, waitingMinor: "1000000" });
    expect(list.waiting[0]).toMatchObject({ kind: "sale_payment", number: sale.number, reference: "GTB1001", recordedByName: "cashier@transfers.test", branchName: "Main" });
    // The owner's own transfer counts straight away.
    const own = await sell(owner, {});
    expect(own.payments[0]?.confirmation).toBe("confirmed");
    // It came in.
    await request(http).post(`/api/v1/transfers/sale_payment/${list.waiting[0].id}/confirm`).set(auth(manager)).send({}).expect(403);
    const confirmed = await request(http).post(`/api/v1/transfers/sale_payment/${list.waiting[0].id}/confirm`).set(auth(accountant)).send({}).expect(200);
    expect(confirmed.body.data.transfer).toMatchObject({ confirmation: "confirmed", confirmedVia: "by_hand", checkedByName: "accountant@transfers.test" });
    await request(http).post(`/api/v1/transfers/sale_payment/${list.waiting[0].id}/confirm`).set(auth(accountant)).send({}).expect(409);
    expect(await balanceOf("1160")).toBe("0");
    expect(await balanceOf("1100")).toBe("2000000");
    expect((await waiting()).waitingCount).toBe(0);
    // Cancelling the sale takes the money back out of the bank.
    await request(http).post(`/api/v1/sales/${sale.id}/void`).set(auth(owner)).send({ reason: "Wrong shoes" }).expect(200);
    expect(await balanceOf("1100")).toBe("1000000");
    expect(await balanceOf("1160")).toBe("0");
  });

  it("writes off a walk-in's transfer that never came, and puts a customer's back on what they owe", async () => {
    const walkIn = await sell(cashier, { reference: "FAKE1" });
    const id = walkIn.payments[0]?.id;
    const owed = await request(http).post(`/api/v1/transfers/sale_payment/${id}/not-received`).set(auth(owner)).send({ settle: "owed", reason: "Fake alert" }).expect(400);
    expect(owed.body.error.code).toBe("NO_CUSTOMER");
    const lost = await request(http).post(`/api/v1/transfers/sale_payment/${id}/not-received`).set(auth(owner)).send({ settle: "lost", reason: "Fake alert" }).expect(200);
    expect(lost.body.data.transfer).toMatchObject({ confirmation: "not_received", notReceivedAs: "lost", note: "Fake alert" });
    expect(await balanceOf("6960")).toBe("1000000");
    // The cashier who took it is told.
    const told = await request(http).get("/api/v1/notifications").set(auth(cashier)).expect(200);
    expect(told.body.data.items[0]).toMatchObject({ kind: "transfer.not_received", saleId: walkIn.id });

    const tunde = await sell(cashier, { reference: "TB77" }, { customerId });
    await request(http)
      .post(`/api/v1/transfers/sale_payment/${tunde.payments[0]?.id}/not-received`)
      .set(auth(accountant))
      .send({ settle: "owed", reason: "Not in the bank after two days" })
      .expect(200);
    const sale = await request(http).get(`/api/v1/sales/${tunde.id}`).set(auth(owner)).expect(200);
    expect(sale.body.data.sale).toMatchObject({ paidMinor: "0", balanceMinor: "1000000" });
    expect(sale.body.data.sale.payments[0]).toMatchObject({ confirmation: "not_received", notReceivedAs: "owed" });
    expect((await request(http).get(`/api/v1/debtors/${customerId}`).set(auth(owner)).expect(200)).body.data.account.owingMinor).toBe("1000000");

    // He pays by transfer at the counter; that waits too, and when it never comes he owes it again.
    const paid = await request(http)
      .post(`/api/v1/debtors/${customerId}/payments`)
      .set(auth(cashier))
      .send({ amountMinor: "1000000", method: "transfer", reference: "TB78" })
      .expect(201);
    const paymentId = paid.body.data.payment.id as string;
    expect((await waiting()).waiting[0]).toMatchObject({ kind: "customer_payment", customerName: "Tunde Bello" });
    await request(http).post(`/api/v1/transfers/customer_payment/${paymentId}/not-received`).set(auth(owner)).send({ reason: "Never came" }).expect(200);
    expect((await request(http).get(`/api/v1/debtors/${customerId}`).set(auth(owner)).expect(200)).body.data.account.owingMinor).toBe("1000000");
    expect(await balanceOf("1160")).toBe("0");
  });

  it("confirms a waiting transfer from the bank statement, and waits again when the match is undone", async () => {
    const sale = await sell(cashier, { reference: "GTB5555" });
    const saved = await request(http)
      .post("/api/v1/imports/statement")
      .set(auth(owner))
      .send({ accountLabel: "GTBank", rows: [{ date: today, description: "NIP CR GTB5555", reference: "GTB5555", moneyIn: "10,000.00", moneyOut: "" }], dryRun: false })
      .expect(200);
    expect(saved.body.data.autoMatched).toBe(1);
    const viewed = await request(http).get(`/api/v1/sales/${sale.id}`).set(auth(owner)).expect(200);
    expect(viewed.body.data.sale.payments[0].confirmation).toBe("confirmed");
    expect(await balanceOf("1160")).toBe("0");
    // Matched to the statement: unmatch there before cancelling.
    expect((await request(http).post(`/api/v1/sales/${sale.id}/void`).set(auth(owner)).send({ reason: "Mistake" }).expect(409)).body.error.code).toBe("MATCHED_TO_BANK");
    const done = await request(http).get("/api/v1/reconciliation").query({ status: "done" }).set(auth(owner)).expect(200);
    const line = done.body.data.items.find((item: { reference: string | null; description: string }) => (item.reference ?? item.description).includes("GTB5555"));
    await request(http).post(`/api/v1/reconciliation/${line.id}/undo`).set(auth(owner)).expect(200);
    expect(await balanceOf("1160")).toBe("1000000");
    expect((await waiting()).waiting.map((item: { saleId: string }) => item.saleId)).toContain(sale.id);
  });

  it("lists discounts, cancellations, returns, cancelled payments and lost transfers, by person", async () => {
    // The manager lowers a price and gives a discount off the total.
    const discounted = await request(http)
      .post("/api/v1/sales")
      .set(auth(manager))
      .send({ lines: [{ productId, quantity: "2", unit: "piece", unitPriceMinor: "900000" }], discountMinor: "50000", payments: [{ method: "cash", amountMinor: "1750000" }] })
      .expect(201);
    const credit = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId, quantity: "1", unit: "piece" }], customerId, dueDate: inDays(7), comment: "Pays Friday", payments: [{ method: "cash", amountMinor: "0" }] })
      .expect(201);
    await request(http)
      .post(`/api/v1/sales/${credit.body.data.sale.id}/returns`)
      .set(auth(manager))
      .send({ lines: [{ saleLineId: credit.body.data.sale.lines[0].id, quantity: "1" }], reason: "Wrong size" })
      .expect(201);
    const cash = await request(http).post(`/api/v1/debtors/${customerId}/payments`).set(auth(owner)).send({ amountMinor: "100000", method: "cash" }).expect(201);
    const cashId = cash.body.data.payment.id as string;
    await request(http).post(`/api/v1/payments/${cashId}/void`).set(auth(owner)).send({ reason: "Typed twice" }).expect(200);

    await request(http).get("/api/v1/money/discounts-cancellations").set(auth(cashier)).expect(403);
    const report = await request(http).get("/api/v1/money/discounts-cancellations").set(auth(owner)).expect(200);
    const data = report.body.data;
    expect(data.discounts[0]).toMatchObject({ saleId: discounted.body.data.sale.id, discountMinor: "50000", loweredMinor: "200000", givenMinor: "250000", byName: "manager@transfers.test" });
    expect(data.cancellations[0]).toMatchObject({ reason: "Wrong shoes", byName: "Ngozi Owner", totalMinor: "1000000", paid: true });
    expect(data.returns[0]).toMatchObject({ totalMinor: "1000000", reason: "Wrong size", byName: "manager@transfers.test" });
    // Cancelled by hand; the payment whose transfer never came is listed with the lost transfers instead.
    expect(data.paymentsCancelled).toHaveLength(1);
    expect(data.paymentsCancelled[0]).toMatchObject({ amountMinor: "100000", method: "cash", reason: "Typed twice", byName: "Ngozi Owner" });
    expect(data.transfersNotReceived.map((row: { settle: string }) => row.settle).sort()).toEqual(["lost", "owed", "owed"]);
    expect(data.totals).toMatchObject({ discountsMinor: "250000", cancelledSalesMinor: "1000000", returnsMinor: "1000000", transfersNotReceivedMinor: "3000000", paymentsCancelledMinor: "100000" });
    const cashierRow = data.people.find((row: { name: string }) => row.name === "cashier@transfers.test");
    expect(cashierRow).toMatchObject({ lostMinor: "3000000", lostCount: 3 });
    expect(data.people.find((row: { name: string }) => row.name === "manager@transfers.test")).toMatchObject({ discountsMinor: "250000", discountCount: 1, returnsCount: 1 });
    // A shop day with nothing in it.
    const empty = await request(http).get("/api/v1/money/discounts-cancellations").query({ from: inDays(-40), to: inDays(-40) }).set(auth(owner)).expect(200);
    expect(empty.body.data.totals.discountsMinor).toBe("0");
    expect(await balanceOf("1160")).toBe("1000000");
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
