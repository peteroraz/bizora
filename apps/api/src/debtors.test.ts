import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
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
      email: `owner.${label}@debtors.test`,
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

describe("debtors and payments", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let cashierToken = "";
  let salesToken = "";
  let chikaId = "";
  let oldSaleId = "";
  let newSaleId = "";
  let firstPaymentId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;
  const binary = (response: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
  };
  const saleBalance = async (id: string) => (await request(app.getHttpServer()).get(`/api/v1/sales/${id}`).set(auth(a.token)).expect(200)).body.data.sale.balanceMinor as string;

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
    cashierToken = await invite(http, a.token, "cashier@debtors.test", "CASHIER", a.branchId, a.businessId);
    salesToken = await invite(http, a.token, "sales@debtors.test", "SALES", a.branchId, a.businessId);
    const rice = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "50", openingCostMinor: "40000000" }).expect(201);
    const riceId = rice.body.data.product.id as string;
    const chika = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201);
    chikaId = chika.body.data.customer.id;
    const credit = (bags: string, paid: string, dueDate: string, comment: string) => ({
      lines: [{ productId: riceId, quantity: bags, unit: "bag" }],
      customerId: chikaId,
      payments: paid === "0" ? [] : [{ method: "cash", amountMinor: paid }],
      dueDate,
      comment,
    });
    oldSaleId = (await request(http).post("/api/v1/sales").set(auth(a.token)).send(credit("1", "0", "2099-01-01", "Pays end of month")).expect(201)).body.data.sale.id;
    newSaleId = (await request(http).post("/api/v1/sales").set(auth(a.token)).send(credit("2", "500000", "2099-02-01", "Part paid")).expect(201)).body.data.sale.id;
    // The first debt is now overdue.
    await client.query("UPDATE sales SET due_date = '2026-01-01' WHERE id = $1", [oldSaleId]);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lists who owes, overdue first, and shows the cashier no phone numbers", async () => {
    const http = app.getHttpServer();
    const owner = await request(http).get("/api/v1/debtors").set(auth(a.token)).expect(200);
    expect(owner.body.data.totals).toEqual({ owingMinor: "2500000", overdueMinor: "1000000", debtors: 1, overdueDebtors: 1 });
    expect(owner.body.data.items[0]).toMatchObject({ customerId: chikaId, name: "Mama Chika", phone: "+2348031234567", owingMinor: "2500000", overdueMinor: "1000000", oldestDueDate: "2026-01-01", openSales: 2 });
    const cashier = await request(http).get("/api/v1/debtors").query({ filter: "overdue" }).set(auth(cashierToken)).expect(200);
    expect(cashier.body.data.items[0]).toMatchObject({ phoneLast4: "4567" });
    expect(cashier.body.data.items[0]).not.toHaveProperty("phone");
    await request(http).get("/api/v1/debtors").set(auth(salesToken)).expect(403);
    const totals = await request(http).get("/api/v1/debtors/totals").set(auth(cashierToken)).expect(200);
    expect(totals.body.data).toMatchObject({ owingMinor: "2500000", overdueMinor: "1000000", debtors: 1 });
    const account = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(cashierToken)).expect(200);
    expect(account.body.data.account).toMatchObject({ owingMinor: "2500000", overdueMinor: "1000000" });
    expect(account.body.data.account.sales.map((sale: { overdue: boolean }) => sale.overdue)).toEqual([true, false]);
    expect(account.body.data.account.reminder).toMatchObject({ phone: null, hrefPrefix: "https://wa.me/" });
    expect(account.body.data.account.reminder.text).toContain("You owe ₦25,000.00, of which ₦10,000.00 is overdue");
  });

  it("applies a part payment to the oldest debt first and posts it to the accounts", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(salesToken)).send({ amountMinor: "100000", method: "cash" }).expect(403);
    const over = await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(cashierToken)).send({ amountMinor: "2600000", method: "cash" }).expect(400);
    expect(over.body.error.message).toContain("owes only ₦25,000.00");
    const paid = await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(cashierToken)).send({ amountMinor: "1200000", method: "transfer", reference: "GTB 0412" }).expect(201);
    firstPaymentId = paid.body.data.payment.id;
    expect(paid.body.data.payment).toMatchObject({ number: "PAY-000001", amountMinor: "1200000", method: "transfer", status: "recorded" });
    expect(paid.body.data.payment.allocations.map((item: { saleId: string; amountMinor: string }) => [item.saleId, item.amountMinor])).toEqual([
      [oldSaleId, "1000000"],
      [newSaleId, "200000"],
    ]);
    expect(await saleBalance(oldSaleId)).toBe("0");
    expect(await saleBalance(newSaleId)).toBe("1300000");
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(before.accounts, "1200") - balance(after.accounts, "1200")).toBe(1_200_000n);
    // A payment for one chosen sale.
    const chosen = await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(cashierToken)).send({ amountMinor: "100000", method: "cash", saleId: newSaleId }).expect(201);
    expect(chosen.body.data.payment.allocations).toEqual([{ saleId: newSaleId, number: expect.any(String), amountMinor: "100000" }]);
    await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(cashierToken)).send({ amountMinor: "100000", method: "cash", saleId: oldSaleId }).expect(400);
    const sale = await request(http).get(`/api/v1/sales/${newSaleId}`).set(auth(a.token)).expect(200);
    expect(sale.body.data.sale.laterPayments.map((item: { number: string }) => item.number)).toEqual(["PAY-000001", "PAY-000002"]);
    const invoice = await request(http).get(`/api/v1/sales/${newSaleId}/documents/invoice`).set(auth(a.token)).buffer(true).parse(binary).expect(200);
    expect(Buffer.from(invoice.body).subarray(0, 5).toString()).toBe("%PDF-");
    const receipt = await request(http).get(`/api/v1/payments/${firstPaymentId}/receipt`).set(auth(cashierToken)).buffer(true).parse(binary).expect(200);
    expect(receipt.headers["content-disposition"]).toContain('filename="Payment-receipt-PAY-000001.pdf"');
  });

  it("cancels a payment only for managers, and a sale with payments cannot be cancelled first", async () => {
    const http = app.getHttpServer();
    const blocked = await request(http).post(`/api/v1/sales/${newSaleId}/void`).set(auth(a.token)).send({ reason: "Returned" }).expect(409);
    expect(blocked.body.error.code).toBe("HAS_PAYMENTS");
    await request(http).post(`/api/v1/payments/${firstPaymentId}/void`).set(auth(cashierToken)).send({ reason: "Wrong customer" }).expect(403);
    const voided = await request(http).post(`/api/v1/payments/${firstPaymentId}/void`).set(auth(a.token)).send({ reason: "Wrong customer" }).expect(200);
    expect(voided.body.data.payment).toMatchObject({ status: "voided", voidReason: "Wrong customer" });
    expect(await saleBalance(oldSaleId)).toBe("1000000");
    // ₦13,000 - ₦1,000 paid for this sale alone + ₦2,000 back from the cancelled payment.
    expect(await saleBalance(newSaleId)).toBe("1400000");
    await request(http).post(`/api/v1/payments/${firstPaymentId}/void`).set(auth(a.token)).send({ reason: "Again" }).expect(409);
    expect((await ledger.trialBalance(a.tenantId, a.businessId)).balanced).toBe(true);
  });

  it("shares a statement by link, which a manager can replace", async () => {
    const http = app.getHttpServer();
    const account = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(a.token)).expect(200);
    const token = (account.body.data.account.statementPath as string).replace("/s/", "");
    const statement = await request(http).get(`/api/v1/public/statements/${token}`).expect(200);
    expect(statement.body.data.statement).toMatchObject({ customerName: "Mama Chika", owingMinor: "2400000", overdueMinor: "1000000" });
    expect(JSON.stringify(statement.body.data.statement)).not.toMatch(/phone|tenant|cost|234803/i);
    expect(statement.body.data.statement.payments.map((item: { number: string }) => item.number)).toEqual(["PAY-000002"]);
    const pdf = await request(http).get(`/api/v1/public/statements/${token}/pdf`).buffer(true).parse(binary).expect(200);
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe("%PDF-");
    await request(http).post(`/api/v1/debtors/${chikaId}/statement-link`).set(auth(cashierToken)).expect(403);
    const rotated = await request(http).post(`/api/v1/debtors/${chikaId}/statement-link`).set(auth(a.token)).expect(200);
    expect(rotated.body.data.account.statementPath).not.toBe(account.body.data.account.statementPath);
    await request(http).get(`/api/v1/public/statements/${token}`).expect(404);
  });

  it("syncs a payment taken offline once", async () => {
    const http = app.getHttpServer();
    const id = uuidv7();
    const op = { id: uuidv7(), type: "payment.record", occurredAt: new Date().toISOString(), payload: { customerId: chikaId, id, amountMinor: "50000", method: "cash", receivedAt: new Date(Date.now() - 600_000).toISOString() } };
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(cashierToken)).send({ operations: [op] }).expect(200);
    expect(pushed.body.data.results[0]).toMatchObject({ status: "applied", result: { payment: { id, amountMinor: "50000" } } });
    const again = await request(http).post("/api/v1/sync/push").set(auth(cashierToken)).send({ operations: [op] }).expect(200);
    expect(again.body.data.results[0].status).toBe("duplicate");
  });

  it("lets a cashier add a customer at the counter with a name and phone, and nothing more", async () => {
    const http = app.getHttpServer();
    const added = await request(http)
      .post("/api/v1/customers")
      .set(auth(cashierToken))
      .send({ name: "Bola Ade", phone: "08051112222", email: "bola@example.com", tags: ["vip"], creditAllowed: true })
      .expect(201);
    expect(added.body.data.customer).toMatchObject({ name: "Bola Ade", phoneLast4: "2222", limited: true, credit: { allowed: false } });
    const full = await request(http).get(`/api/v1/customers/${added.body.data.customer.id}`).set(auth(a.token)).expect(200);
    expect(full.body.data.customer).toMatchObject({ email: null, tags: [] });
    const walkIn = await request(http).post("/api/v1/customers").set(auth(cashierToken)).send({ name: "Walk-in: man in blue cap", isWalkIn: true }).expect(201);
    expect(walkIn.body.data.customer).toMatchObject({ isWalkIn: true });
    await request(http).patch(`/api/v1/customers/${added.body.data.customer.id}`).set(auth(cashierToken)).send({ name: "Changed", phone: "08051112222" }).expect(403);
    const taken = await request(http).post("/api/v1/customers").set(auth(cashierToken)).send({ name: "Someone", phone: "08031234567" }).expect(409);
    expect(taken.body.error.code).toBe("DUPLICATE_PHONE");
  });

  it("keeps each organization's debtors and payments to itself", async () => {
    const http = app.getHttpServer();
    await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(b.token)).expect(404);
    await request(http).post(`/api/v1/debtors/${chikaId}/payments`).set(auth(b.token)).send({ amountMinor: "100", method: "cash" }).expect(404);
    await request(http).get(`/api/v1/payments/${firstPaymentId}/receipt`).set(auth(b.token)).expect(404);
    await request(http).post(`/api/v1/payments/${firstPaymentId}/void`).set(auth(b.token)).send({ reason: "x" }).expect(404);
    const list = await request(http).get("/api/v1/debtors").set(auth(b.token)).expect(200);
    expect(list.body.data.totals.debtors).toBe(0);
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
