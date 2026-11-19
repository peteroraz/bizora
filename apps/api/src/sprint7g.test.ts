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
  DEFAULT_PLAN_CODE: "starter",
  AI_DAILY_CAPTURE_LIMIT: 2,
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

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

/** A PNG header is all the photo checks read: width and height come from the file itself. */
function png(width: number, height: number) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from(`pixels ${width}x${height} ${Math.random()}`)]).toString("base64");
}
const VOICE = Buffer.from("a voice note the fake model does not listen to").toString("base64");

describe("sprint 7g: no plan limits, AI reads per shop, product photos, voice for sales and stock", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let organizationId = "";
  let businessId = "";
  let mainId = "";
  let marketId = "";
  let milkId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const inShop = async (token: string, branchId: string) =>
    (await request(http).post("/api/v1/auth/select-context").set(auth(token)).send({ organizationId, businessId, branchId }).expect(201)).body.data.accessToken as string;
  const onHand = async (token: string) => (await request(http).get(`/api/v1/products/${milkId}`).set(auth(token)).expect(200)).body.data.product.stock.quantity as string;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@voice.test", password, displayName: "Bisi Owner", organizationName: "Bisi Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    organizationId = registered.body.data.tenant.tenantId as string;
    businessId = registered.body.data.tenant.businessId as string;
    mainId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Stores", branchName: "Main" })
      .expect(200);
    const milk = await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", defaultCostMinor: "35000", openingQuantity: "10", openingCostMinor: "350000" }).expect(201);
    milkId = milk.body.data.product.id as string;
    owner = await inShop(owner, mainId);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets a starter business open many shops and invite staff for now", async () => {
    const plan = await client.query<{ limits: Record<string, unknown> }>("SELECT limits FROM plans WHERE code = 'starter'");
    expect(plan.rows[0]?.limits).toMatchObject({ max_branches: 1000, max_staff: 10000, ai_daily_reads: 100 });
    const market = await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Market shop", businessId }).expect(201);
    marketId = market.body.data.branch.id as string;
    await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Third shop", businessId }).expect(201);
    for (const role of ["SALES", "CASHIER", "INVENTORY"]) await invite(http, owner, `${role.toLowerCase()}@voice.test`, role, mainId, businessId);
  });

  it("counts AI reads per shop: one busy shop does not use up another's", async () => {
    const read = (token: string) => request(http).post("/api/v1/captures").set(auth(token)).send({ target: "cart", files: [{ mimeType: "audio/webm", data: VOICE }] });
    expect((await read(owner).expect(200)).body.data.remainingToday).toBe(1);
    expect((await read(owner).expect(200)).body.data.remainingToday).toBe(0);
    expect((await read(owner).expect(429)).body.error.message).toContain("This shop has used all 2");
    const inMarket = await inShop(owner, marketId);
    const status = await request(http).get("/api/v1/captures/status").set(auth(inMarket)).expect(200);
    expect(status.body.data).toMatchObject({ limit: 2, remainingToday: 2 });
    owner = await inShop(inMarket, mainId);
  });

  it("reads a spoken sale into cart rows for sales staff, but not for the store keeper", async () => {
    const sales = (await request(http).post("/api/v1/auth/login").send({ email: "sales@voice.test", password }).expect(201)).body.data.accessToken as string;
    const store = (await request(http).post("/api/v1/auth/login").send({ email: "inventory@voice.test", password }).expect(201)).body.data.accessToken as string;
    // The main shop's reads are used up; the market shop's are not, so test there with an owner session.
    const inMarket = await inShop(owner, marketId);
    const heard = await request(http).post("/api/v1/captures").set(auth(inMarket)).send({ target: "cart", files: [{ mimeType: "audio/mp4", data: VOICE }] }).expect(200);
    expect(heard.body.data.rows[0]).toMatchObject({ product: "Peak Milk", quantity: "2", payment: "cash" });
    expect(Object.keys(heard.body.data.rows[0]).sort()).toEqual(["customer", "paid", "payment", "price", "product", "quantity", "unit"]);
    expect(heard.body.data.transcript).toBe("I sold two Peak Milk for cash.");
    // Nothing is sold by hearing it: the cart is still checked and charged by a person.
    expect((await client.query("SELECT 1 FROM sales WHERE tenant_id = $1", [organizationId])).rows).toHaveLength(0);
    expect((await request(http).get("/api/v1/captures/status").set(auth(sales)).expect(200)).body.data.targets).toContain("cart");
    const storeTargets = (await request(http).get("/api/v1/captures/status").set(auth(store)).expect(200)).body.data.targets as string[];
    // The store keeper's stock changes are read too; they wait for a manager (ADR-034).
    expect(storeTargets).toEqual(expect.arrayContaining(["stock_in", "stock_count", "stock_change", "stock_move"]));
    expect(storeTargets).not.toContain("cart");
    await request(http).post("/api/v1/captures").set(auth(store)).send({ target: "cart", files: [{ mimeType: "audio/webm", data: VOICE }] }).expect(403);
    owner = await inShop(inMarket, mainId);
  });

  it("keeps up to five photos per product, checks each one, and shows the main one in lists", async () => {
    const add = (data: string, token = owner) => request(http).post(`/api/v1/products/${milkId}/photos`).set(auth(token)).send({ contentType: "image/png", dataBase64: data });
    expect((await add(Buffer.from("not an image").toString("base64")).expect(400)).body.error.code).toBe("BAD_PHOTO");
    expect((await add(png(20, 20)).expect(400)).body.error.code).toBe("BAD_PHOTO");
    expect((await add(png(4000, 300)).expect(400)).body.error.code).toBe("BAD_PHOTO");
    for (let index = 0; index < 5; index += 1) await add(png(400 + index, 400));
    expect((await add(png(400, 400)).expect(409)).body.error.code).toBe("TOO_MANY_PHOTOS");
    const store = (await request(http).post("/api/v1/auth/login").send({ email: "inventory@voice.test", password }).expect(201)).body.data.accessToken as string;
    await add(png(300, 300), store).expect(403);

    const listed = await request(http).get(`/api/v1/products/${milkId}/photos`).set(auth(store)).expect(200);
    const photos = listed.body.data.items as { id: string; position: number; width: number; url: string }[];
    expect(photos.map((photo) => photo.position)).toEqual([0, 1, 2, 3, 4]);
    const file = await request(http).get(photos[0]!.url.split("?")[0]!).set(auth(store)).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");

    // The last photo becomes the main one; removing one closes the gap.
    await request(http).post(`/api/v1/products/${milkId}/photos/${photos[4]!.id}/main`).set(auth(owner)).expect(200);
    await request(http).delete(`/api/v1/products/${milkId}/photos/${photos[1]!.id}`).set(auth(owner)).expect(200);
    const after = (await request(http).get(`/api/v1/products/${milkId}/photos`).set(auth(owner)).expect(200)).body.data.items as { id: string; position: number; width: number }[];
    expect(after.map((photo) => photo.position)).toEqual([0, 1, 2, 3]);
    expect(after[0]).toMatchObject({ id: photos[4]!.id, width: 404 });
    expect(after.map((photo) => photo.id)).not.toContain(photos[1]!.id);
    const list = await request(http).get("/api/v1/products").query({ q: "peak" }).set(auth(owner)).expect(200);
    expect(list.body.data.items[0].photoUrl).toContain(photos[4]!.id);
    const changes = await request(http).get(`/api/v1/products/${milkId}/changes`).set(auth(owner)).expect(200);
    expect(JSON.stringify(changes.body.data)).toContain("product.photo_removed");

    // Another business cannot see the photos.
    const other = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "other@voice.test", password, displayName: "Other", organizationName: "Other Ltd", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    await request(http).get(`/api/v1/products/${milkId}/photos/${after[0]!.id}`).set(auth(other.body.data.accessToken)).expect(404);
  });

  it("saves a spoken list of damaged, missing or found goods, with a note on each and never below zero", async () => {
    const before = await onHand(owner);
    expect(before).toBe("10000");
    const rows = [
      { product: "peak milk", change: "remove", reason: "got wet", quantity: "2", unit: "", note: "Rain came in" },
      { product: "Peak Milk", change: "", reason: "found", quantity: "1", unit: "tin", note: "Behind the fridge" },
    ];
    const checked = await request(http).post("/api/v1/imports/stock-change").set(auth(owner)).send({ rows }).expect(200);
    expect(checked.body.data).toMatchObject({ committed: false, totals: { create: 2, error: 0 } });
    expect(checked.body.data.results[0].message).toContain("damaged");

    // A note is required, the direction and reason must agree, and the list cannot take more than is on the shelf.
    const bad = await request(http)
      .post("/api/v1/imports/stock-change")
      .set(auth(owner))
      .send({
        rows: [
          { product: "Peak Milk", change: "remove", reason: "damaged", quantity: "1", unit: "", note: "" },
          { product: "Peak Milk", change: "add", reason: "expired", quantity: "1", unit: "", note: "Wrong way" },
          { product: "Peak Milk", change: "remove", reason: "missing", quantity: "6", unit: "", note: "Half gone" },
          { product: "Peak Milk", change: "remove", reason: "missing", quantity: "6", unit: "", note: "And the rest" },
          { product: "Golden Morn", change: "remove", reason: "damaged", quantity: "1", unit: "", note: "Torn" },
        ],
        dryRun: false,
      })
      .expect(200);
    expect(bad.body.data.committed).toBe(false);
    const fields = bad.body.data.results.map((result: { status: string; errors?: { field: string }[] }) => (result.status === "error" ? result.errors?.[0]?.field : "ok"));
    expect(fields).toEqual(["note", "reason", "ok", "quantity", "product"]);
    expect(await onHand(owner)).toBe(before);

    const saved = await request(http).post("/api/v1/imports/stock-change").set(auth(owner)).send({ source: "capture", rows, dryRun: false }).expect(200);
    expect(saved.body.data.committed).toBe(true);
    expect(await onHand(owner)).toBe("9000");
    const movements = await request(http).get(`/api/v1/products/${milkId}/movements`).set(auth(owner)).expect(200);
    expect(movements.body.data.items.slice(0, 2)).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "damaged", note: "Rain came in" }), expect.objectContaining({ reason: "found", note: "Behind the fridge" })]),
    );
    // The store keeper's list is checked the same way, and waits for a manager or owner (ADR-034).
    const store = (await request(http).post("/api/v1/auth/login").send({ email: "inventory@voice.test", password }).expect(201)).body.data.accessToken as string;
    const asked = await request(http).post("/api/v1/imports/stock-change").set(auth(store)).send({ rows }).expect(200);
    expect(asked.body.data).toMatchObject({ waiting: true, totals: { create: 2, error: 0 } });
  });

  it("saves a spoken count: the owner's applies at once, the store keeper's waits for approval", async () => {
    const saved = await request(http).post("/api/v1/imports/stock-count").set(auth(owner)).send({ rows: [{ product: "Peak Milk", counted: "8", unit: "", note: "Morning count" }], dryRun: false }).expect(200);
    expect(saved.body.data.committed).toBe(true);
    expect(await onHand(owner)).toBe("8000");
    const store = (await request(http).post("/api/v1/auth/login").send({ email: "inventory@voice.test", password }).expect(201)).body.data.accessToken as string;
    const bad = await request(http).post("/api/v1/imports/stock-count").set(auth(store)).send({ rows: [{ product: "Peak Milk", counted: "-1", unit: "" }] }).expect(200);
    expect(bad.body.data.results[0].errors[0].field).toBe("counted");
    await request(http).post("/api/v1/imports/stock-count").set(auth(store)).send({ rows: [{ product: "Peak Milk", counted: "7", unit: "" }], dryRun: false }).expect(200);
    expect(await onHand(owner)).toBe("8000");
    const waiting = await client.query<{ status: string }>("SELECT status FROM stock_counts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [organizationId]);
    expect(waiting.rows[0]?.status).toBe("pending");
  });

  it("moves a spoken list to another shop by its name, never more than is on the shelf", async () => {
    const check = await request(http)
      .post("/api/v1/imports/stock-move")
      .set(auth(owner))
      .send({ rows: [{ product: "Peak Milk", quantity: "3", unit: "", toShop: "market shop", note: "" }, { product: "Peak Milk", quantity: "1", unit: "", toShop: "Main", note: "" }, { product: "Peak Milk", quantity: "9", unit: "", toShop: "Market shop", note: "" }] })
      .expect(200);
    const fields = check.body.data.results.map((result: { status: string; errors?: { field: string }[] }) => (result.status === "error" ? result.errors?.[0]?.field : "ok"));
    expect(fields).toEqual(["ok", "toShop", "quantity"]);
    const saved = await request(http).post("/api/v1/imports/stock-move").set(auth(owner)).send({ rows: [{ product: "Peak Milk", quantity: "3", unit: "", toShop: "market shop", note: "To the stall" }], dryRun: false }).expect(200);
    expect(saved.body.data.committed).toBe(true);
    expect(await onHand(owner)).toBe("5000");
    const inMarket = await inShop(owner, marketId);
    expect(await onHand(inMarket)).toBe("3000");
    const log = await client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE tenant_id = $1 AND action = 'import.saved' ORDER BY created_at", [organizationId]);
    expect(log.rows.map((row) => JSON.parse(row.metadata_json).kind)).toEqual(["stock_change", "stock_count", "stock_count", "stock_move"]);
  });
});
