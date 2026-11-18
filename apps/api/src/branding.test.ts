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
};

const password = "LocalOnly!Passw0rd";

type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string, industryCode = "general-retail") {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@brand.test`,
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

const hasImage = (pdf: Buffer) => pdf.toString("latin1").includes("/Subtype /Image");

describe("company branding on documents", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let cashierToken = "";
  let receiptToken = "";
  let saleId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const pdfBody = (response: request.Response) => Buffer.from(response.body as Buffer);
  const binary = (req: request.Test) => req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });

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
    cashierToken = await invite(http, a.token, "cashier@brand.test", "CASHIER", a.branchId, a.businessId);
    const milk = await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "100", openingCostMinor: "3500000" }).expect(201);
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ lines: [{ productId: milk.body.data.product.id, quantity: "2", unit: "tin" }], payments: [{ method: "cash", amountMinor: "90000" }] })
      .expect(201);
    saleId = sale.body.data.sale.id;
    receiptToken = String(sale.body.data.sale.receiptPath).split("/").pop() ?? "";
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("starts with the default colour, no logo and no messages", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/organizations/current/branding").set(auth(a.token)).expect(200);
    expect(response.body.data.branding).toEqual({ handle: "shop-a", about: null, primaryColor: "#1D4ED8", receiptMessage: null, invoiceMessage: null, documentTerms: null, logo: null });
    const receipt = await binary(request(app.getHttpServer()).get(`/api/v1/sales/${saleId}/documents/receipt`).set(auth(a.token))).expect(200);
    expect(hasImage(pdfBody(receipt))).toBe(false);
  });

  it("saves the owner's colour and messages, tidied, and refuses colours too light for paper", async () => {
    const http = app.getHttpServer();
    const saved = await request(http)
      .patch("/api/v1/organizations/current/branding")
      .set(auth(a.token))
      .send({ primaryColor: "#0b6e4f", receiptMessage: "  Thank you for buying from us!  \r\n\n\n\nCome again.  ", invoiceMessage: "Pay to GTBank 0123456789, Ada Stores", documentTerms: "Goods sold are not returnable." })
      .expect(200);
    expect(saved.body.data.branding).toMatchObject({ primaryColor: "#0B6E4F", receiptMessage: "Thank you for buying from us!\n\nCome again.", invoiceMessage: "Pay to GTBank 0123456789, Ada Stores", documentTerms: "Goods sold are not returnable." });
    const light = await request(http).patch("/api/v1/organizations/current/branding").set(auth(a.token)).send({ primaryColor: "#FFFF66" }).expect(400);
    expect(JSON.stringify(light.body)).toContain("too light");
    await request(http).patch("/api/v1/organizations/current/branding").set(auth(a.token)).send({ receiptMessage: "x".repeat(301) }).expect(400);
    // Clearing a message.
    const cleared = await request(http).patch("/api/v1/organizations/current/branding").set(auth(a.token)).send({ documentTerms: "" }).expect(200);
    expect(cleared.body.data.branding.documentTerms).toBeNull();
    expect(cleared.body.data.branding.receiptMessage).toBe("Thank you for buying from us!\n\nCome again.");
  });

  it("takes a PNG logo, refuses anything that is not a real picture, and prints the logo on receipts", async () => {
    const http = app.getHttpServer();
    const logo = png(48);
    const uploaded = await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/png", dataBase64: logo.toString("base64") }).expect(200);
    expect(uploaded.body.data.branding.logo).toMatchObject({ contentType: "image/png", width: 48, height: 48, byteSize: logo.length });
    const fetched = await binary(request(http).get("/api/v1/organizations/current/logo").set(auth(cashierToken))).expect(200);
    expect(fetched.headers["content-type"]).toBe("image/png");
    expect(fetched.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(pdfBody(fetched), logo)).toBe(0);

    const notImage = await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/png", dataBase64: Buffer.from("<svg onload=alert(1)>not a picture</svg>").toString("base64") }).expect(400);
    expect(notImage.body.error.message).toBe("Choose a PNG or JPG picture.");
    await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/jpeg", dataBase64: logo.toString("base64") }).expect(400);
    const tiny = await request(http).put("/api/v1/organizations/current/logo").set(auth(a.token)).send({ contentType: "image/png", dataBase64: png(8).toString("base64") }).expect(400);
    expect(tiny.body.error.message).toContain("too small");

    const receipt = await binary(request(http).get(`/api/v1/sales/${saleId}/documents/receipt`).set(auth(a.token))).expect(200);
    expect(hasImage(pdfBody(receipt))).toBe(true);
    // The customer's receipt link shows the same branded PDF.
    const shared = await binary(request(http).get(`/api/v1/public/receipts/${receiptToken}/documents/receipt.pdf`)).expect(200);
    expect(hasImage(pdfBody(shared))).toBe(true);
    const sample = await binary(request(http).get("/api/v1/organizations/current/branding/sample").query({ type: "invoice" }).set(auth(a.token))).expect(200);
    expect(sample.headers["content-type"]).toContain("application/pdf");
    expect(hasImage(pdfBody(sample))).toBe(true);
  });

  it("lets staff see the logo but only owners change branding, and keeps each company's branding to itself", async () => {
    const http = app.getHttpServer();
    const staffView = await request(http).get("/api/v1/organizations/current/branding").set(auth(cashierToken)).expect(200);
    expect(staffView.body.data.branding.logo).not.toBeNull();
    await request(http).patch("/api/v1/organizations/current/branding").set(auth(cashierToken)).send({ receiptMessage: "hacked" }).expect(403);
    await request(http).put("/api/v1/organizations/current/logo").set(auth(cashierToken)).send({ contentType: "image/png", dataBase64: png(48).toString("base64") }).expect(403);
    await request(http).delete("/api/v1/organizations/current/logo").set(auth(cashierToken)).expect(403);
    await request(http).get("/api/v1/organizations/current/branding/sample").set(auth(cashierToken)).expect(403);

    await request(http).get("/api/v1/organizations/current/logo").set(auth(b.token)).expect(404);
    const other = await request(http).get("/api/v1/organizations/current/branding").set(auth(b.token)).expect(200);
    expect(other.body.data.branding).toMatchObject({ receiptMessage: null, logo: null });
  });

  it("removes the logo", async () => {
    const http = app.getHttpServer();
    const removed = await request(http).delete("/api/v1/organizations/current/logo").set(auth(a.token)).expect(200);
    expect(removed.body.data.branding.logo).toBeNull();
    await request(http).get("/api/v1/organizations/current/logo").set(auth(a.token)).expect(404);
    const receipt = await binary(request(http).get(`/api/v1/sales/${saleId}/documents/receipt`).set(auth(a.token))).expect(200);
    expect(hasImage(pdfBody(receipt))).toBe(false);
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
