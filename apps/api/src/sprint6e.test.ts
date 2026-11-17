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
      email: `owner.${label}@links.test`,
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

describe("sprint 6e: links that come from the business", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let cashierToken = "";
  let saleId = "";
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
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    cashierToken = await invite(http, a.token, "cashier@links.test", "CASHIER", a.branchId, a.businessId);
    const milk = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "100", openingCostMinor: "3500000" }).expect(201);
    chikaId = (await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(201)).body.data.customer.id;
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ lines: [{ productId: milk.body.data.product.id, quantity: "2", unit: "tin" }], customerId: chikaId, payments: [{ method: "cash", amountMinor: "50000" }], dueDate: "2099-01-31", comment: "Friday" })
      .expect(201);
    saleId = sale.body.data.sale.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("gives every new business a link name from its own name, and never the same one twice", async () => {
    const http = app.getHttpServer();
    const view = await request(http).get("/api/v1/organizations/current/branding").set(auth(a.token)).expect(200);
    expect(view.body.data.branding.handle).toBe("shop-a");
    const other = await request(http).get("/api/v1/organizations/current/branding").set(auth(b.token)).expect(200);
    expect(other.body.data.branding.handle).toBe("shop-b");
    // A second company called "Shop a" gets the name with a short piece of its id.
    const twin = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "twin@links.test", password, displayName: "Twin", organizationName: "Shop a", countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra" })
      .expect(201);
    const twinView = await request(http).get("/api/v1/organizations/current/branding").set(auth(twin.body.data.accessToken)).expect(200);
    expect(twinView.body.data.branding.handle).toMatch(/^shop-a-[0-9a-f]{6}$/);
  });

  it("puts the business name in receipt and statement links, and writes the WhatsApp message as the business", async () => {
    const http = app.getHttpServer();
    const sale = await request(http).get(`/api/v1/sales/${saleId}`).set(auth(a.token)).expect(200);
    expect(sale.body.data.sale.receiptPath).toMatch(/^\/shop-a\/r\/[A-Za-z0-9_-]{20,64}$/);
    expect(sale.body.data.sale.whatsApp.text).toBe("Hello Mama Chika, here is your receipt R-000001 from Shop a: ");
    const account = await request(http).get(`/api/v1/debtors/${chikaId}`).set(auth(a.token)).expect(200);
    expect(account.body.data.account.statementPath).toMatch(/^\/shop-a\/s\//);
    const token = String(sale.body.data.sale.receiptPath).split("/").pop();
    const receipt = await request(http).get(`/api/v1/public/receipts/${token}`).expect(200);
    expect(receipt.body.data.receipt).toMatchObject({ handle: "shop-a", businessName: "Shop a" });
  });

  it("lets the owner choose the name and a line about the business, but not one that is taken or kept for Bizora", async () => {
    const http = app.getHttpServer();
    const free = await request(http).get("/api/v1/organizations/current/handle-check").query({ handle: "Ada-Stores" }).set(auth(a.token)).expect(200);
    expect(free.body.data).toEqual({ handle: "ada-stores", available: true, reason: null });
    const taken = await request(http).get("/api/v1/organizations/current/handle-check").query({ handle: "shop-b" }).set(auth(a.token)).expect(200);
    expect(taken.body.data).toMatchObject({ available: false, reason: "Another business already uses that name." });
    const reserved = await request(http).get("/api/v1/organizations/current/handle-check").query({ handle: "login" }).set(auth(a.token)).expect(200);
    expect(reserved.body.data.available).toBe(false);

    await request(http).patch("/api/v1/organizations/current/profile").set(auth(a.token)).send({ handle: "shop-b" }).expect(409);
    await request(http).patch("/api/v1/organizations/current/profile").set(auth(a.token)).send({ handle: "app" }).expect(400);
    await request(http).patch("/api/v1/organizations/current/profile").set(auth(cashierToken)).send({ handle: "cashier-shop" }).expect(403);
    const saved = await request(http)
      .patch("/api/v1/organizations/current/profile")
      .set(auth(a.token))
      .send({ handle: "Ada-Stores", about: "  Provisions and drinks.\n Open 8am to 7pm.  " })
      .expect(200);
    expect(saved.body.data.branding).toMatchObject({ handle: "ada-stores", about: "Provisions and drinks. Open 8am to 7pm." });
    // New links use the new name; the token stays, so links already sent still find the receipt.
    const sale = await request(http).get(`/api/v1/sales/${saleId}`).set(auth(a.token)).expect(200);
    expect(sale.body.data.sale.receiptPath).toMatch(/^\/ada-stores\/r\//);
    const audit = await client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE tenant_id = $1 AND action = 'profile.updated'", [a.tenantId]);
    expect(JSON.parse(audit.rows[0]?.metadata_json ?? "{}")).toMatchObject({ from: "shop-a", to: "ada-stores" });
  });

  it("shows a public page with who the business is and nothing about its sales or customers", async () => {
    const http = app.getHttpServer();
    await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/png", dataBase64: png(32).toString("base64") }).expect(200);
    await request(http).patch("/api/v1/organizations/current/branding").set(auth(a.token)).send({ primaryColor: "#0B6E4F" }).expect(200);
    const page = await request(http).get("/api/v1/public/profiles/ada-stores").expect(200);
    expect(page.body.data.profile).toEqual({ name: "Shop a", handle: "ada-stores", about: "Provisions and drinks. Open 8am to 7pm.", phone: null, address: null, color: "#0B6E4F", hasLogo: true });
    expect(JSON.stringify(page.body.data.profile)).not.toMatch(/Chika|tenant|owing|INV-|08031234567/i);
    const logo = await request(http).get("/api/v1/public/profiles/ada-stores/logo").expect(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    await request(http).get("/api/v1/public/profiles/shop-a").expect(404);
    await request(http).get("/api/v1/public/profiles/no-such-business").expect(404);
    await request(http).get("/api/v1/public/profiles/shop-b/logo").expect(404);
    await request(http).get("/api/v1/public/profiles/..%2Fapi").expect(404);
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
