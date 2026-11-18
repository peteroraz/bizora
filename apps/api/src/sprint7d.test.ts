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


describe("sprint 7d: returns from customers and to suppliers", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let cashier = "";
  let storekeeper = "";
  let riceId = "";
  let cashSale: { id: string; lines: { id: string }[] };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const inDays = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const stockOf = async () => {
    const product = await request(http).get(`/api/v1/products/${riceId}`).set(auth(owner)).expect(200);
    return product.body.data.product.stock?.quantity ?? product.body.data.stock?.quantity ?? product.body.data.product.quantity;
  };
  const cashFlow = async (kind: string) => {
    const cash = await request(http).get("/api/v1/money/cash").set(auth(owner)).expect(200);
    return cash.body.data.shops[0].flows.find((flow: { kind: string }) => flow.kind === kind);
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
        email: "owner@returns.test",
        password,
        displayName: "Ife Owner",
        organizationName: "Ife Provisions",
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
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ife Provisions", branchName: "Main" })
      .expect(200);
    manager = await invite(http, owner, "manager@returns.test", "MANAGER", branchId, businessId);
    cashier = await invite(http, owner, "cashier@returns.test", "CASHIER", branchId, businessId);
    storekeeper = await invite(http, owner, "store@returns.test", "INVENTORY", branchId, businessId);
    // ₦5,000 a bag; 10 bags that cost ₦3,000 each.
    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(owner))
      .send({ name: "Rice 5kg", baseUnit: "piece", priceMinor: "500000", openingQuantity: "10", openingCostMinor: "3000000" })
      .expect(201);
    riceId = product.body.data.product.id as string;
    // Three bags for cash, with ₦1,500 off the whole sale: ₦13,500 paid.
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: riceId, quantity: "3", unit: "piece" }], discountMinor: "150000", payments: [{ method: "cash", amountMinor: "1350000" }] })
      .expect(201);
    cashSale = sale.body.data.sale;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it("gives back what the goods were paid for, with their share of the discount, and puts them back on the shelf", async () => {
    // A business set up before returns existed has no "Returns from customers" account yet.
    await client.exec("DELETE FROM ledger_accounts WHERE code = '4150'");
    await request(http).post(`/api/v1/sales/${cashSale.id}/returns`).set(auth(cashier)).send({ lines: [{ saleLineId: cashSale.lines[0]?.id, quantity: "1" }], reason: "Torn bag" }).expect(403);
    const returned = await request(http)
      .post(`/api/v1/sales/${cashSale.id}/returns`)
      .set(auth(manager))
      .send({ id: uuidv7(), lines: [{ saleLineId: cashSale.lines[0]?.id, quantity: "1" }], refundMethod: "cash", reason: "Wrong size" })
      .expect(201);
    const sale = returned.body.data.sale;
    expect(sale).toMatchObject({ returnedMinor: "450000", canReturn: true });
    expect(sale.returns[0]).toMatchObject({ number: "RET-000001", totalMinor: "450000", refundMinor: "450000", offBalanceMinor: "0", refundMethod: "cash" });
    expect(sale.lines[0].returnedQuantity).toBe("1000");
    expect(await stockOf()).toBe("8000");
    expect(await cashFlow("refunds")).toMatchObject({ outMinor: "450000" });
  });

  it("takes broken goods back without restocking them, and never more than was sold", async () => {
    await request(http)
      .post(`/api/v1/sales/${cashSale.id}/returns`)
      .set(auth(manager))
      .send({ lines: [{ saleLineId: cashSale.lines[0]?.id, quantity: "3" }], reason: "Too many" })
      .expect(400);
    const broken = await request(http)
      .post(`/api/v1/sales/${cashSale.id}/returns`)
      .set(auth(manager))
      .send({ lines: [{ saleLineId: cashSale.lines[0]?.id, quantity: "2", backToStock: false }], refundMethod: "transfer", reason: "Weevils" })
      .expect(201);
    // The last of the line takes what is left: ₦13,500 − ₦4,500.
    expect(broken.body.data.sale.returns[1]).toMatchObject({ totalMinor: "900000", refundMethod: "transfer" });
    expect(broken.body.data.sale.returnedMinor).toBe("1350000");
    expect(await stockOf()).toBe("8000");
    await request(http).post(`/api/v1/sales/${cashSale.id}/returns`).set(auth(manager)).send({ lines: [{ saleLineId: cashSale.lines[0]?.id, quantity: "1" }], reason: "Again" }).expect(400);
    // A sale with returns can no longer be cancelled as a whole.
    const cancel = await request(http).post(`/api/v1/sales/${cashSale.id}/void`).set(auth(owner)).send({ reason: "Mistake" }).expect(409);
    expect(cancel.body.error.code).toBe("HAS_RETURNS");
  });

  it("takes a return off what a customer still owes before paying money back", async () => {
    const customer = await request(http).post("/api/v1/customers").set(auth(owner)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201);
    const credit = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ lines: [{ productId: riceId, quantity: "2", unit: "piece" }], customerId: customer.body.data.customer.id, dueDate: inDays(30), comment: "Pays at month end", payments: [{ method: "cash", amountMinor: "200000" }] })
      .expect(201);
    expect(credit.body.data.sale.balanceMinor).toBe("800000");
    const back = await request(http)
      .post(`/api/v1/sales/${credit.body.data.sale.id}/returns`)
      .set(auth(owner))
      .send({ lines: [{ saleLineId: credit.body.data.sale.lines[0].id, quantity: "2" }], reason: "Changed her mind" });
    expect(back.status).toBe(201);
    expect(back.body.data.sale).toMatchObject({ balanceMinor: "0", returnedMinor: "1000000" });
    expect(back.body.data.sale.returns[0]).toMatchObject({ offBalanceMinor: "800000", refundMinor: "200000" });
    const debtors = await request(http).get("/api/v1/debtors").set(auth(owner)).expect(200);
    expect(JSON.stringify(debtors.body.data)).not.toContain("Mama Chika");
  });

  it("sends goods back to a supplier, off what is owed or for money back", async () => {
    await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(storekeeper))
      .send({ productId: riceId, quantity: "4", unit: "piece", totalCostMinor: "1200000", paidFrom: "credit", supplier: "Olam Rice" })
      .expect(201);
    const names = await request(http).get("/api/v1/suppliers/names").set(auth(storekeeper)).expect(200);
    const olamId = names.body.data.items[0].id as string;
    // A storekeeper may only take it off what is owed.
    await request(http).post("/api/v1/stock/return-to-supplier").set(auth(storekeeper)).send({ productId: riceId, supplierId: olamId, quantity: "1", unit: "piece", settle: "cash" }).expect(403);
    const sent = await request(http)
      .post("/api/v1/stock/return-to-supplier")
      .set(auth(storekeeper))
      .send({ id: uuidv7(), productId: riceId, supplierId: olamId, quantity: "1", unit: "piece", note: "Wet bag" })
      .expect(201);
    expect(sent.body.data.documentNumber).toBe("SR-000001");
    const olam = await request(http).get(`/api/v1/suppliers/${olamId}`).set(auth(owner)).expect(200);
    expect(olam.body.data.owedMinor).toBe("900000");
    expect(olam.body.data.entries[0]).toMatchObject({ kind: "return", amountMinor: "300000", product: "Rice 5kg", canCancel: false });
    // Worth more than is owed: refused; the money-back way works.
    await request(http).post("/api/v1/stock/return-to-supplier").set(auth(manager)).send({ productId: riceId, supplierId: olamId, quantity: "4", unit: "piece" }).expect(400);
    await request(http).post("/api/v1/stock/return-to-supplier").set(auth(manager)).send({ productId: riceId, supplierId: olamId, quantity: "1", unit: "piece", settle: "cash" }).expect(201);
    expect((await request(http).get(`/api/v1/suppliers/${olamId}`).set(auth(owner)).expect(200)).body.data.owedMinor).toBe("900000");
    // More than is on the shelf: refused.
    await request(http).post("/api/v1/stock/return-to-supplier").set(auth(manager)).send({ productId: riceId, supplierId: olamId, quantity: "50", unit: "piece", settle: "cash" }).expect(422);
  });

  it("shows returns in profit and keeps the books balanced", async () => {
    const profit = await request(http).get("/api/v1/money/profit").set(auth(owner)).expect(200);
    // Sales ₦15,000 + ₦10,000, discount ₦1,500, returns ₦13,500 + ₦10,000.
    expect(profit.body.data).toMatchObject({ salesMinor: "2500000", discountsMinor: "150000", returnsMinor: "2350000", netSalesMinor: "0" });
    // Cost: 5 bags sold (₦15,000) less 3 back on the shelf (₦9,000); the 2 broken bags stay a cost.
    expect(profit.body.data.costOfSalesMinor).toBe("600000");
    const balance = await request(http).get("/api/v1/ledger/trial-balance").set(auth(owner)).expect(200);
    expect(balance.body.data.balanced).toBe(true);
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
