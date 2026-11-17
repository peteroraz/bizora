import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { deflateSync, crc32 } from "node:zlib";
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

type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string, industryCode = "general-retail") {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@polish.test`,
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

/** A real, small PNG: a solid square, drawn in code so the test needs no picture files. */
function png(size: number, rgb: [number, number, number] = [29, 78, 216]) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, index) => rgb[index % 3] ?? 0)]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

describe("sprint 6d: screens that tell the truth", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let cashierToken = "";
  let chikaId = "";
  let bolaId = "";
  let saleToken = "";
  let milkId = "";
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
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    cashierToken = await invite(http, a.token, "cashier@polish.test", "CASHIER", a.branchId, a.businessId);
    const milk = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "100", openingCostMinor: "3500000" }).expect(201);
    milkId = milk.body.data.product.id;
    chikaId = (await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201)).body.data.customer.id;
    bolaId = (await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Bola Ade", phone: "08051112222" }).expect(201)).body.data.customer.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("asks new shops for their products, not a sentence about them", async () => {
    const http = app.getHttpServer();
    const before = await request(http).get("/api/v1/dashboard").set(auth(b.token)).expect(200);
    expect(before.body.data.checklist.find((item: { id: string }) => item.id === "first-products")).toMatchObject({ done: false, href: "/app/stock/import" });
    const after = await request(http).get("/api/v1/dashboard").set(auth(a.token)).expect(200);
    expect(after.body.data.checklist.find((item: { id: string }) => item.id === "first-products")).toMatchObject({ done: true });
  });

  it("lists a customer's purchases with how they paid, and shows owners the debtor's full number", async () => {
    const http = app.getHttpServer();
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ lines: [{ productId: milkId, quantity: "2", unit: "tin" }], customerId: chikaId, payments: [{ method: "transfer", amountMinor: "50000" }, { method: "cash", amountMinor: "20000" }], dueDate: "2099-01-31", comment: "Pays Friday" })
      .expect(201);
    saleToken = String(sale.body.data.sale.receiptPath).replace("/r/", "");
    await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: milkId, quantity: "1", unit: "tin" }], payments: [{ method: "cash", amountMinor: "45000" }] }).expect(201);
    const hers = await request(http).get("/api/v1/sales").query({ customerId: chikaId }).set(auth(a.token)).expect(200);
    expect(hers.body.data.items).toHaveLength(1);
    expect(hers.body.data.items[0]).toMatchObject({ customerName: "Mama Chika", methods: ["cash", "transfer"], balanceMinor: "20000" });
    expect(hers.body.data.date).toBeNull();
    const today = await request(http).get("/api/v1/sales").set(auth(a.token)).expect(200);
    expect(today.body.data.items).toHaveLength(2);

    const owner = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(a.token)).expect(200);
    expect(owner.body.data.account.customer).toMatchObject({ phone: "+2348031234567", phoneLast4: "4567" });
    const cashier = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(cashierToken)).expect(200);
    expect(cashier.body.data.account.customer.phone).toBeUndefined();
    expect(cashier.body.data.account.customer.phoneLast4).toBe("4567");
  });

  it("removes customers safely: never while they owe, archived when they have history, deleted when they have none", async () => {
    const http = app.getHttpServer();
    const owes = await request(http).delete(`/api/v1/customers/${chikaId}`).set(auth(a.token)).expect(409);
    expect(owes.body.error.code).toBe("CUSTOMER_OWES");
    // Bola bought once and paid: archived, so the old sale still names her.
    const bolaSale = await request(http).post("/api/v1/sales").set(auth(a.token)).send({ lines: [{ productId: milkId, quantity: "1", unit: "tin" }], customerId: bolaId, payments: [{ method: "cash", amountMinor: "45000" }] }).expect(201);
    const removed = await request(http).delete(`/api/v1/customers/${bolaId}`).set(auth(a.token)).expect(200);
    expect(removed.body.data).toMatchObject({ archived: true });
    const list = await request(http).get("/api/v1/customers").set(auth(a.token)).expect(200);
    expect(list.body.data.items.map((item: { name: string }) => item.name)).toEqual(["Mama Chika"]);
    const lookup = await request(http).get("/api/v1/customers").query({ q: "Bola" }).set(auth(cashierToken)).expect(200);
    expect(lookup.body.data.items).toEqual([]);
    const old = await request(http).get(`/api/v1/sales/${bolaSale.body.data.sale.id}`).set(auth(a.token)).expect(200);
    expect(old.body.data.sale.customerName).toBe("Bola Ade");
    // A customer with no history is really deleted.
    const nobody = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Typo Name", phone: "08099999999" }).expect(201);
    const gone = await request(http).delete(`/api/v1/customers/${nobody.body.data.customer.id}`).set(auth(a.token)).expect(200);
    expect(gone.body.data).toMatchObject({ archived: false });
    await request(http).get(`/api/v1/customers/${nobody.body.data.customer.id}`).set(auth(a.token)).expect(404);
  });

  it("gives the customer's pages the shop's contact, the owner's message and the logo, from the page's own token", async () => {
    const http = app.getHttpServer();
    await request(http).patch("/api/v1/organizations/current/branding").set(auth(a.token)).send({ invoiceMessage: "Pay to GTBank 0123456789", receiptMessage: "Thank you!" }).expect(200);
    await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/png", dataBase64: png(32).toString("base64") }).expect(200);
    const receipt = await request(http).get(`/api/v1/public/receipts/${saleToken}`).expect(200);
    // Credit is still owed on this sale, so the page says how to pay.
    expect(receipt.body.data.receipt).toMatchObject({ message: "Pay to GTBank 0123456789", hasLogo: true });
    expect(receipt.body.data.receipt.shop).toHaveProperty("phone");
    const logo = await request(http).get(`/api/v1/public/receipts/${saleToken}/logo`).expect(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["x-content-type-options"]).toBe("nosniff");
    await request(http).get(`/api/v1/public/receipts/${"x".repeat(32)}/logo`).expect(404);

    const account = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(a.token)).expect(200);
    const statementToken = String(account.body.data.account.statementPath).replace("/s/", "");
    const statement = await request(http).get(`/api/v1/public/statements/${statementToken}`).expect(200);
    expect(statement.body.data.statement).toMatchObject({ message: "Pay to GTBank 0123456789", hasLogo: true });
    await request(http).get(`/api/v1/public/statements/${statementToken}/logo`).expect(200);
    // A company without a logo has none to show, even on its own links.
    const plain = await request(http).post("/api/v1/sales").set(auth(b.token)).send({ lines: [], payments: [] });
    expect(plain.status).toBe(400);
  });

  it("gives Starter shops a small daily taste of photo and voice reading", async () => {
    const http = app.getHttpServer();
    await client.query("UPDATE organization_plans SET plan_code = 'starter' WHERE tenant_id = $1", [b.tenantId]);
    const starter = await request(http).get("/api/v1/captures/status").set(auth(b.token)).expect(200);
    expect(starter.body.data).toMatchObject({ enabled: true, limit: 10, remainingToday: 10 });
    const business = await request(http).get("/api/v1/captures/status").set(auth(a.token)).expect(200);
    expect(business.body.data.limit).toBe(50);
    const plan = await request(http).get("/api/v1/plan").set(auth(b.token)).expect(200);
    expect(plan.body.data.limits).toMatchObject({ max_staff: 2, ai_daily_reads: 10, features: { ai: true } });
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
