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

describe("quick sales and imports", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let salesToken = "";
  let managerToken = "";
  let cashierToken = "";
  let milkId = "";
  let riceId = "";
  let customerId = "";
  let firstSaleId = "";
  let creditSaleId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;
  const onHand = async (id: string) => {
    const product = await request(app.getHttpServer()).get(`/api/v1/products/${id}`).set(auth(a.token)).expect(200);
    return product.body.data.product.stock.quantity as string;
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

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
    salesToken = await invite(http, a.token, "sales@sales.test", "SALES", a.branchId, a.businessId);
    managerToken = await invite(http, a.token, "manager@sales.test", "MANAGER", a.branchId, a.businessId);
    cashierToken = await invite(http, a.token, "cashier@sales.test", "CASHIER", a.branchId, a.businessId);
    const milk = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", packs: [{ unitCode: "carton", baseQuantity: "48", priceMinor: "2000000" }], openingQuantity: "96", openingCostMinor: "3360000" })
      .expect(201);
    milkId = milk.body.data.product.id;
    const rice = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "8500000", openingQuantity: "10", openingCostMinor: "75000000" }).expect(201);
    riceId = rice.body.data.product.id;
    const customer = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201);
    customerId = customer.body.data.customer.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("sells in packs and pieces, takes stock out at cost, and posts money, revenue and cost of goods", async () => {
    const http = app.getHttpServer();
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ lines: [{ productId: milkId, quantity: "1", unit: "carton" }, { productId: milkId, quantity: "2", unit: "tin" }], payments: [{ method: "cash", amountMinor: "2090000" }] })
      .expect(201);
    firstSaleId = sale.body.data.sale.id;
    expect(sale.body.data.sale).toMatchObject({ number: "R-000001", subtotalMinor: "2090000", totalMinor: "2090000", paidMinor: "2090000", balanceMinor: "0", status: "completed" });
    expect(sale.body.data.sale.lines[0]).not.toHaveProperty("costMinor");
    expect(await onHand(milkId)).toBe("46000");
    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1000-01")).toBe(20_900_00n);
    expect(balance(trial.accounts, "4000")).toBe(-20_900_00n);
    // 50 tins at ₦350 average cost.
    expect(balance(trial.accounts, "5000")).toBe(17_500_00n);
  });

  it("splits payments, and only managers give discounts or credit", async () => {
    const http = app.getHttpServer();
    const split = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "3000000" }, { method: "transfer", amountMinor: "4000000" }, { method: "pos", amountMinor: "1500000" }] })
      .expect(201);
    expect(split.body.data.sale.payments.map((payment: { method: string }) => payment.method)).toEqual(["cash", "transfer", "pos"]);

    const below = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag", unitPriceMinor: "8000000" }], payments: [{ method: "cash", amountMinor: "8000000" }] }).expect(403);
    expect(below.body.error.message).toContain("below its price");
    await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], discountMinor: "100000", payments: [] }).expect(403);
    const credit = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], customerId, payments: [] }).expect(403);
    expect(credit.body.error.message).toContain("credit");
    const noCustomer = await request(http).post("/api/v1/sales").set(auth(managerToken)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [] }).expect(400);
    expect(noCustomer.body.error.code).toBe("CUSTOMER_REQUIRED");
    const overpaid = await request(http).post("/api/v1/sales").set(auth(managerToken)).send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "9000000" }] }).expect(400);
    expect(overpaid.body.error.code).toBe("OVERPAID");

    const managed = await request(http)
      .post("/api/v1/sales")
      .set(auth(managerToken))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], discountMinor: "500000", customerId, payments: [{ method: "cash", amountMinor: "5000000" }], dueDate: "2099-01-31", comment: "Pays on Friday" })
      .expect(201);
    creditSaleId = managed.body.data.sale.id;
    // A credit sale also gets an invoice for what is owed; a cash sale only a receipt.
    expect(managed.body.data.sale).toMatchObject({ invoiceNumber: "INV-000001", documents: ["invoice", "receipt"] });
    expect(split.body.data.sale).toMatchObject({ invoiceNumber: null, documents: ["receipt"] });
    expect(managed.body.data.sale).toMatchObject({ totalMinor: "8000000", paidMinor: "5000000", balanceMinor: "3000000", customerName: "Mama Chika" });
    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1200")).toBe(30_000_00n);
    expect(balance(trial.accounts, "4100")).toBe(5_000_00n);
    expect(balance(trial.accounts, "1150")).toBe(15_000_00n);
  });

  it("cancels a sale: stock comes back at the cost it left with and the entries are reversed", async () => {
    const http = app.getHttpServer();
    await request(http).post(`/api/v1/sales/${firstSaleId}/void`).set(auth(salesToken)).send({ reason: "Wrong item" }).expect(403);
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const voided = await request(http).post(`/api/v1/sales/${firstSaleId}/void`).set(auth(managerToken)).send({ reason: "Wrong item" }).expect(200);
    expect(voided.body.data.sale).toMatchObject({ status: "voided", voidReason: "Wrong item" });
    expect(await onHand(milkId)).toBe("96000");
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(before.accounts, "1000-01") - balance(after.accounts, "1000-01")).toBe(20_900_00n);
    expect(balance(before.accounts, "5000") - balance(after.accounts, "5000")).toBe(17_500_00n);
    await request(http).post(`/api/v1/sales/${firstSaleId}/void`).set(auth(managerToken)).send({ reason: "Again" }).expect(409);
  });

  it("shows staff their own sales and managers everyone's, with daily totals", async () => {
    const http = app.getHttpServer();
    await request(http).post("/api/v1/sales").set(auth(cashierToken)).send({ lines: [{ productId: milkId, quantity: "1", unit: "tin" }], payments: [{ method: "cash", amountMinor: "45000" }] }).expect(201);
    const mine = await request(http).get("/api/v1/sales").set(auth(cashierToken)).expect(200);
    expect(mine.body.data.items).toHaveLength(1);
    const all = await request(http).get("/api/v1/sales").set(auth(managerToken)).expect(200);
    expect(all.body.data.items.length).toBe(4);
    await request(http).get(`/api/v1/sales/${firstSaleId}`).set(auth(cashierToken)).expect(404);
    const summary = await request(http).get("/api/v1/sales/summary").set(auth(managerToken)).expect(200);
    expect(summary.body.data).toMatchObject({ date: today, mine: false, count: 3, totalMinor: "16545000", creditMinor: "3000000" });
    expect(summary.body.data.byMethod).toEqual({ cash: "8045000", transfer: "4000000", pos: "1500000" });
    const cashierSummary = await request(http).get("/api/v1/sales/summary").set(auth(cashierToken)).expect(200);
    expect(cashierSummary.body.data).toMatchObject({ mine: true, count: 1, totalMinor: "45000" });
  });

  it("opens a receipt from its WhatsApp link without signing in, and nothing more", async () => {
    const http = app.getHttpServer();
    const sale = await request(http).get(`/api/v1/sales/${firstSaleId}`).set(auth(a.token)).expect(200);
    const token = (sale.body.data.sale.receiptPath as string).split("/").pop() ?? "";
    const receipt = await request(http).get(`/api/v1/public/receipts/${token}`).expect(200);
    expect(receipt.body.data.receipt).toMatchObject({ businessName: "Shop a", number: "R-000001", status: "voided", totalMinor: "2090000" });
    // The shop's own contact is shown on purpose (6d); costs, the customer's phone and the account never are.
    const { shop, ...rest } = receipt.body.data.receipt as { shop: { phone: string | null; address: string | null } };
    expect(Object.keys(shop).sort()).toEqual(["address", "phone"]);
    expect(JSON.stringify(rest)).not.toMatch(/cost|phone|tenant/i);
    await request(http).get("/api/v1/public/receipts/not-a-real-receipt-token-xx").expect(404);
    // The customer's number goes into the WhatsApp link only for staff who may see customer contacts.
    const owner = await request(http).get(`/api/v1/sales/${creditSaleId}`).set(auth(a.token)).expect(200);
    expect(owner.body.data.sale.whatsApp.phone).toBe("+2348031234567");
    expect(owner.body.data.sale.customerPhoneLast4).toBe("4567");
  });

  it("syncs offline sales once, keeping the device's number and giving an official one", async () => {
    const http = app.getHttpServer();
    const id = uuidv7();
    const op = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id, provisionalNumber: "DEV1-000007", soldAt: new Date(Date.now() - 3_600_000).toISOString(), lines: [{ productId: milkId, quantity: "2", unit: "tin" }], payments: [{ method: "cash", amountMinor: "90000" }] } };
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [op] }).expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    expect(pushed.body.data.results[0].result.sale).toMatchObject({ id, provisionalNumber: "DEV1-000007", source: "offline" });
    expect(pushed.body.data.results[0].result.sale.number).toMatch(/^R-\d{6}$/);
    const again = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [op] }).expect(200);
    expect(again.body.data.results[0].status).toBe("duplicate");
    const old = { ...op, id: uuidv7(), payload: { ...op.payload, id: uuidv7(), soldAt: new Date(Date.now() - 9 * 86_400_000).toISOString() } };
    const tooOld = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [old] }).expect(200);
    expect(tooOld.body.data.results[0]).toMatchObject({ status: "rejected", error: { code: "TOO_OLD" } });
  });

  it("imports products and current stock after checking every row", async () => {
    const http = app.getHttpServer();
    const rows = [
      { name: "Golden Penny Semovita", category: "Grains", unit: "bag", price: "4,500", cost: "3800", quantity: "20", lowStock: "5", packUnit: "", packSize: "", packPrice: "" },
      { name: "Peak Milk", unit: "", price: "470", quantity: "10" },
      { name: "Coke 50cl", unit: "bottle", price: "300", packUnit: "crate", packSize: "12", packPrice: "3,400" },
      { name: "Bad Row", unit: "boxes of joy", price: "abc" },
    ];
    const checked = await request(http).post("/api/v1/imports/products").set(auth(a.token)).send({ rows }).expect(200);
    expect(checked.body.data.committed).toBe(false);
    expect(checked.body.data.results.map((result: { status: string }) => result.status)).toEqual(["create", "update", "create", "error"]);
    expect(checked.body.data.results[1].message).toContain("quantity is ignored");
    expect(checked.body.data.results[3].errors.map((error: { field: string }) => error.field)).toEqual(["unit", "price"]);
    const refused = await request(http).post("/api/v1/imports/products").set(auth(a.token)).send({ rows, dryRun: false }).expect(200);
    expect(refused.body.data.committed).toBe(false);
    const saved = await request(http).post("/api/v1/imports/products").set(auth(a.token)).send({ rows: rows.slice(0, 3), dryRun: false }).expect(200);
    expect(saved.body.data).toMatchObject({ committed: true, totals: { create: 2, update: 1, error: 0 } });
    const list = await request(http).get("/api/v1/products").query({ q: "semovita" }).set(auth(a.token)).expect(200);
    expect(list.body.data.items[0].stock).toMatchObject({ quantity: "20000", valueMinor: "7600000" });
    const milk = await request(http).get(`/api/v1/products/${milkId}`).set(auth(a.token)).expect(200);
    expect(milk.body.data.product.priceMinor).toBe("47000");
    await request(http).post("/api/v1/imports/products").set(auth(salesToken)).send({ rows }).expect(403);
    const tooMany = await request(http).post("/api/v1/imports/products").set(auth(a.token)).send({ rows: Array.from({ length: 2001 }, (_, i) => ({ name: `P${i}` })) }).expect(400);
    expect(tooMany.body.error.code).toBe("TOO_MANY_ROWS");
  });

  it("imports sales: today's count fully, older ones are history only", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const riceBefore = await onHand(riceId);
    const rows = [
      { date: today, product: "Rice 50kg", quantity: "1", unit: "bag", price: "85000", payment: "cash", ref: "A1" },
      { date: today, product: "peak milk", quantity: "2", total: "940", payment: "trf", ref: "A1" },
      { date: "01/11/2026", product: "Old item not in products", quantity: "3", price: "1000", payment: "cash", ref: "OLD-9" },
      { date: "02/11/2026", product: "Rice 50kg", quantity: "1", price: "80000", payment: "owing", customer: "Mama Chika" },
    ];
    const checked = await request(http).post("/api/v1/imports/sales").set(auth(managerToken)).send({ rows }).expect(200);
    expect(checked.body.data.results.map((result: { status: string; counts: boolean }) => [result.status, result.counts])).toEqual([
      ["create", true],
      ["create", true],
      ["create", false],
      ["create", false],
    ]);
    const saved = await request(http).post("/api/v1/imports/sales").set(auth(managerToken)).send({ rows, dryRun: false }).expect(200);
    expect(saved.body.data.committed).toBe(true);
    expect(await onHand(riceId)).toBe((BigInt(riceBefore) - 1000n).toString());
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    // Only today's receipt (₦85,000 + ₦940) reached the accounts.
    expect(balance(before.accounts, "4000") - balance(after.accounts, "4000")).toBe(85_940_00n);
    const history = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sales WHERE tenant_id = $1 AND history_only", [a.tenantId]);
    expect(history.rows[0]?.n).toBe(2);

    // Counting fully: unknown products and credit without permission are refused before anything is saved.
    const strict = await request(http)
      .post("/api/v1/imports/sales")
      .set(auth(salesToken))
      .send({ mode: "full", rows: [{ date: today, product: "Mystery", price: "100" }, { date: today, product: "Rice 50kg", price: "85000", payment: "credit", customer: "Mama Chika" }] })
      .expect(200);
    expect(strict.body.data.results.map((result: { errors?: { field: string }[] }) => result.errors?.map((error) => error.field))).toEqual([["product"], ["payment"]]);
  });

  it("keeps each organization's sales to itself", async () => {
    const http = app.getHttpServer();
    await request(http).get(`/api/v1/sales/${firstSaleId}`).set(auth(b.token)).expect(404);
    await request(http).post(`/api/v1/sales/${firstSaleId}/void`).set(auth(b.token)).send({ reason: "x" }).expect(404);
    const foreign = await request(http).post("/api/v1/sales").set(auth(b.token)).send({ lines: [{ productId: milkId, quantity: "1", unit: "tin" }], payments: [] }).expect(404);
    expect(foreign.body.error.code).toBe("PRODUCT_NOT_FOUND");
    const list = await request(http).get("/api/v1/sales").set(auth(b.token)).expect(200);
    expect(list.body.data.total).toBe(0);
    const stolen = await request(http).post("/api/v1/sales").set(auth(b.token)).send({ id: (await client.query<{ id: string }>("SELECT id FROM sales WHERE tenant_id = $1 AND source = 'offline' LIMIT 1", [a.tenantId])).rows[0]?.id, lines: [{ productId: milkId, quantity: "1", unit: "tin" }] }).expect(409);
    expect(stolen.body.error.code).toBe("ID_CONFLICT");
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
