import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import { inflateRawSync } from "node:zlib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@bizora/contracts";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { fakeGoogle } from "./test-admin-oidc.js";

const password = "LocalOnly!Passw0rd";
const ADMIN = "http://admin.bizora.test";
const PHOTO = Buffer.from("not really a photo").toString("base64");

describe("ADR-045: running the pilot", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let google: Awaited<ReturnType<typeof fakeGoogle>>;
  let boss = "";
  let watcher = "";
  const a = { token: "", tenantId: "", businessId: "", branchId: "" };
  const b = { token: "", tenantId: "", businessId: "", branchId: "" };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const as = (cookie: string) => ({ cookie, "x-bizora-admin": "1" });

  async function cashierOf(owner: typeof a, email: string) {
    const invited = await request(http).post("/api/v1/invitations").set(auth(owner.token)).send({ email, role: "CASHIER", businessId: owner.businessId, branchId: owner.branchId }).expect(201);
    await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: "Cashier", password }).expect(201);
    return (await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201)).body.data.accessToken as string;
  }

  async function register(email: string, organizationName: string, into: typeof a) {
    const response = await request(http)
      .post("/api/v1/auth/register")
      .send({ email, password, displayName: "Owner", organizationName, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    into.token = response.body.data.accessToken as string;
    Object.assign(into, response.body.data.tenant);
  }

  beforeAll(async () => {
    google = await fakeGoogle();
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
      THROTTLE_AUTH_LIMIT: 500,
      INVITE_TOKEN_EXPOSE: true,
      TRUST_PROXY: false,
      DEFAULT_PLAN_CODE: "business",
      EMAIL_PROVIDER: "console",
      AI_PROVIDER: "fake",
      GOOGLE_OAUTH_CLIENT_ID: "google-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-test-secret",
      GOOGLE_OAUTH_ISSUER: google.issuer,
      ADMIN_WEB_ORIGIN: ADMIN,
      ADMIN_BOOTSTRAP_EMAILS: "boss@bizora.test",
    };
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    await register("ada@kano.test", "Kano Corner Shop", a);
    await register("bola@ibadan.test", "Ibadan Provisions", b);
    boss = await google.signIn(http, "boss@bizora.test", "g-boss");
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "watcher@bizora.test", name: "Watcher", roles: ["viewer"] }).expect(201);
    watcher = await google.signIn(http, "watcher@bizora.test", "g-watcher");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await google?.close();
  });

  describe("switches for one business", () => {
    it("start as the product works today, with payment gateways and advanced accounting off", async () => {
      const me = await request(http).get("/api/v1/auth/me").set(auth(a.token)).expect(200);
      expect(me.body.data.features).toEqual({ offline_voice: true, photo_reads: true, support_view: true, advanced_accounting: false, payment_gateways: false });
      const shown = await request(http).get(`/api/admin/v1/businesses/${a.tenantId}/features`).set("cookie", watcher).expect(200);
      expect(shown.body.data.features.find((row: { feature: string }) => row.feature === "payment_gateways")).toMatchObject({ enabled: false, locked: true });
    });

    it("are changed only by operations, with a reason, and recorded in both activity logs", async () => {
      const url = `/api/admin/v1/businesses/${a.tenantId}/features`;
      await request(http).put(url).set(as(watcher)).send({ feature: "photo_reads", enabled: false, reason: "Pilot: no photo reads yet" }).expect(403);
      await request(http).put(url).set(as(boss)).send({ feature: "photo_reads", enabled: false, reason: "x" }).expect(400);
      await request(http).put(url).set(as(boss)).send({ feature: "card_payments", enabled: true, reason: "Trying something new" }).expect(400);
      await request(http).put(url).set(as(boss)).send({ feature: "payment_gateways", enabled: true, reason: "Owner asked for card payments" }).expect(409);
      await request(http).put(url).set("cookie", boss).send({ feature: "photo_reads", enabled: false, reason: "Pilot: no photo reads yet" }).expect(403);
      await request(http).put(url).set(as(boss)).send({ feature: "photo_reads", enabled: false, reason: "Pilot: no photo reads yet" }).expect(200);

      const admin = await client.query<{ action: string; reason: string }>("SELECT action, reason FROM admin_audit WHERE action = 'business.feature_changed' AND tenant_id = $1", [a.tenantId]);
      expect(admin.rows).toEqual([{ action: "business.feature_changed", reason: "Pilot: no photo reads yet" }]);
      const owner = await client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE action = 'business.feature_changed' AND tenant_id = $1", [a.tenantId]);
      expect(JSON.parse(owner.rows[0]!.metadata_json)).toMatchObject({ feature: "photo_reads", from: true, to: false });
      // The database refuses a locked switch too, whatever the code does.
      await expect(client.query("INSERT INTO business_features (tenant_id, feature, enabled, reason) VALUES ($1, 'payment_gateways', true, 'forced')", [a.tenantId])).rejects.toThrow();
    });

    it("stop photo reads on the server for that business only", async () => {
      const status = await request(http).get("/api/v1/captures/status").set(auth(a.token)).expect(200);
      expect(status.body.data.enabled).toBe(false);
      const refused = await request(http).post("/api/v1/captures").set(auth(a.token)).send({ target: "sales", files: [{ mimeType: "image/jpeg", data: PHOTO }] }).expect(403);
      expect(refused.body.error.code).toBe("FEATURE_OFF");
      expect(refused.body.error.message).toMatch(/Type the rows instead/);
      expect((await request(http).get("/api/v1/captures/status").set(auth(b.token)).expect(200)).body.data.enabled).toBe(true);
      expect((await request(http).get("/api/v1/auth/me").set(auth(a.token)).expect(200)).body.data.features.photo_reads).toBe(false);
    });

    it("stop the support view, even one already open", async () => {
      const base = `/api/admin/v1/businesses/${b.tenantId}`;
      await request(http).post(`${base}/support-view`).set(as(boss)).send({ reason: "Owner says the cash is wrong" }).expect(201);
      await request(http).get(`${base}/records/customers`).set("cookie", boss).expect(200);
      await request(http).put(`${base}/features`).set(as(boss)).send({ feature: "support_view", enabled: false, reason: "Owner asked for no support access" }).expect(200);
      expect((await request(http).get(`${base}/records/customers`).set("cookie", boss).expect(403)).body.error.code).toBe("FEATURE_OFF");
      expect((await request(http).post(`${base}/support-view`).set(as(boss)).send({ reason: "Owner says the cash is wrong" }).expect(403)).body.error.code).toBe("FEATURE_OFF");
      await request(http).put(`${base}/features`).set(as(boss)).send({ feature: "support_view", enabled: true, reason: "Owner asked for help again" }).expect(200);
      await request(http).post(`${base}/support-view`).set(as(boss)).send({ reason: "Owner says the cash is wrong" }).expect(201);
    });

    it("refuse a business that does not exist", async () => {
      await request(http).put("/api/admin/v1/businesses/00000000-0000-4000-8000-000000000000/features").set(as(boss)).send({ feature: "offline_voice", enabled: false, reason: "Testing a missing business" }).expect(404);
      await request(http).get("/api/admin/v1/businesses/not-a-uuid/features").set("cookie", boss).expect(400);
    });
  });

  describe("business records export", () => {
    it("gives the owner every record of their business only, as CSV files in a ZIP", async () => {
      const product = (await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", openingQuantity: "10", openingCostMinor: "60000000" }).expect(201)).body.data.product.id as string;
      const customer = (await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "=HYPERLINK(\"http://bad.test\")", phone: "08031234567" }).expect(201)).body.data.customer.id as string;
      await request(http).post("/api/v1/sales").set(auth(a.token)).send({ customerId: customer, lines: [{ productId: product, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "15000000" }] }).expect(201);
      await request(http).post("/api/v1/customers").set(auth(b.token)).send({ name: "Bola's own customer", phone: "08039999999" }).expect(201);

      const response = await request(http).get("/api/v1/exports/business").set(auth(a.token)).buffer(true).parse(binary).expect(200);
      expect(response.headers["content-type"]).toBe("application/zip");
      expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="bizora-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip"$/);
      expect(response.headers["cache-control"]).toBe("no-store");
      const files = readZip(response.body as Buffer);
      expect(Object.keys(files)).toEqual(expect.arrayContaining(["README.txt", "customers.csv", "sales.csv", "sale_lines.csv", "journal_lines.csv", "activity_log.csv"]));

      const customers = csv(files["customers.csv"]!);
      expect(customers.map((row) => row.name)).toEqual(['\'=HYPERLINK("http://bad.test")']);
      expect(customers[0]).not.toHaveProperty("statement_token");
      expect(customers[0]!.tenant_id).toBe(a.tenantId);
      const sales = csv(files["sales.csv"]!);
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ total_minor: "15000000", paid_minor: "15000000", currency_code: "NGN" });
      expect(sales[0]).not.toHaveProperty("receipt_token");
      expect(csv(files["sale_lines.csv"]!)[0]).toMatchObject({ quantity: "2000", unit_price_minor: "7500000" });
      // Nothing from the other business, anywhere.
      for (const [name, text] of Object.entries(files)) {
        expect(text, name).not.toContain(b.tenantId);
        expect(text, name).not.toContain("Bola's own customer");
      }
      // The books in the export balance.
      const lines = csv(files["journal_lines.csv"]!);
      const debit = lines.reduce((sum, row) => sum + BigInt(row.debit_minor!), 0n);
      const credit = lines.reduce((sum, row) => sum + BigInt(row.credit_minor!), 0n);
      expect(debit).toBe(credit);
      expect(debit > 0n).toBe(true);
      expect(files["activity_log.csv"]).not.toMatch(/ip|user_agent/);

      const logged = await client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE action = 'business.exported' AND tenant_id = $1", [a.tenantId]);
      expect(JSON.parse(logged.rows[0]!.metadata_json).records).toBeGreaterThan(5);
    });

    it("is for the owner and administrators only", async () => {
      const cashier = await cashierOf(a, "cashier@kano.test");
      await request(http).get("/api/v1/exports/business").set(auth(cashier)).expect(403);
      await request(http).get("/api/v1/exports/business").expect(401);
    });
  });

  describe("pilot measures", () => {
    it("keep phone events by name and short code only, refusing anything else", async () => {
      const url = "/api/v1/telemetry/events";
      await request(http).post(url).send({ events: [{ name: "voice.review_shown" }] }).expect(401);
      await request(http).post(url).set(auth(a.token)).send({ events: [{ name: "voice.review_shown", text: "two bags of rice" }] }).expect(400);
      await request(http).post(url).set(auth(a.token)).send({ events: [{ name: "voice.secret_thing" }] }).expect(400);
      await request(http).post(url).set(auth(a.token)).send({ events: [{ name: "voice.review_shown", detail: "two bags of rice" }] }).expect(400);
      await request(http)
        .post(url)
        .set(auth(a.token))
        .send({ events: [{ name: "voice.download_started", detail: "standard" }, { name: "voice.download_failed", detail: "NETWORK" }, { name: "voice.review_shown" }, { name: "voice.sale_confirmed" }] })
        .expect(204);
      const rows = await client.query<{ tenant_id: string; event: string; detail: string | null }>("SELECT tenant_id, event, detail FROM pilot_events WHERE event LIKE 'voice.%' ORDER BY event");
      expect(rows.rows).toEqual([
        { tenant_id: a.tenantId, event: "voice.download_failed", detail: "NETWORK" },
        { tenant_id: a.tenantId, event: "voice.download_started", detail: "standard" },
        { tenant_id: a.tenantId, event: "voice.review_shown", detail: null },
        { tenant_id: a.tenantId, event: "voice.sale_confirmed", detail: null },
      ]);
    });

    it("count how offline work arrives: applied, sent twice, refused with its code", async () => {
      const good = { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { name: "Offline Okoro", phone: "08035550000" } };
      const bad = { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { name: "" } };
      const first = await request(http).post("/api/v1/sync/push").set(auth(a.token)).send({ operations: [good, bad] }).expect(200);
      expect(first.body.data.results.map((result: { status: string }) => result.status)).toEqual(["applied", "rejected"]);
      await request(http).post("/api/v1/sync/push").set(auth(a.token)).send({ operations: [good] }).expect(200);
      const rows = await client.query<{ event: string; detail: string | null }>("SELECT event, detail FROM pilot_events WHERE event LIKE 'sync.%' AND tenant_id = $1 ORDER BY occurred_at, event", [a.tenantId]);
      expect(rows.rows.map((row) => row.event).sort()).toEqual(["sync.applied", "sync.duplicate", "sync.rejected"]);
      expect(rows.rows.find((row) => row.event === "sync.applied")?.detail).toBe("customer.create");
      expect(rows.rows.find((row) => row.event === "sync.rejected")?.detail).toMatch(/^[A-Z_]+$/);
      // Nothing anyone typed is kept.
      const all = JSON.stringify((await client.query("SELECT * FROM pilot_events")).rows);
      expect(all).not.toContain("Okoro");
    });

    it("show Bizora staff counts per business, and a support view of what went wrong", async () => {
      const overview = await request(http).get("/api/admin/v1/pilot/measures?days=7").set("cookie", watcher).expect(200);
      const kano = overview.body.data.businesses.find((row: { id: string }) => row.id === a.tenantId);
      expect(kano).toMatchObject({ name: "Kano Corner Shop", sample: false, sales: 1, customers: 2, salesValue: [{ currency: "NGN", totalMinor: "15000000" }] });
      expect(kano.events).toMatchObject({ "voice.review_shown": 1, "voice.sale_confirmed": 1, "voice.download_failed": 1, "sync.applied": 1, "sync.rejected": 1, "sync.duplicate": 1 });
      expect(overview.body.data.totals).toMatchObject({ businesses: 2, sales: 1, voiceConfirmed: 1 });
      // First steps (item 17): from the records themselves.
      expect(kano.firstSteps).toMatchObject({ registered: expect.any(String), product: expect.any(String), stock: expect.any(String), sale: expect.any(String), creditSale: null, debtPayment: null });
      expect(overview.body.data.firstSteps).toMatchObject({ registered: 2, product: 1, sale: 1, creditSale: 0 });
      expect(overview.body.data.totals.registeredInPeriod).toBe(2);
      expect(JSON.stringify(overview.body.data)).not.toMatch(/HYPERLINK|Okoro|0803/);

      const health = await request(http).get(`/api/admin/v1/businesses/${a.tenantId}/health`).set("cookie", watcher).expect(200);
      expect(health.body.data.syncRefusals).toHaveLength(1);
      expect(health.body.data.voiceProblems).toEqual([expect.objectContaining({ event: "voice.download_failed", code: "NETWORK", total: 1 })]);
      expect(health.body.data.openSessions).toBeGreaterThan(0);
      await request(http).get("/api/admin/v1/pilot/measures").expect(401);
    });
  });


  describe("sample business", () => {
    it("is shown as a sample, and only its records can be deleted, and only by the removal script's setting", async () => {
      await request(http).post("/api/v1/products").set(auth(b.token)).send({ name: "Sample sugar", baseUnit: "bag", priceMinor: "100000", openingQuantity: "2", openingCostMinor: "150000" }).expect(201);
      await client.query("UPDATE organizations SET is_sample = true WHERE id = $1", [b.tenantId]);
      expect((await request(http).get("/api/v1/auth/me").set(auth(b.token)).expect(200)).body.data.organization.isSample).toBe(true);
      const measures = await request(http).get("/api/admin/v1/pilot/measures").set("cookie", watcher).expect(200);
      expect(measures.body.data.totals.businesses).toBe(1);

      // Without the setting, nothing changes: records stay unchangeable for samples too.
      await expect(client.query("DELETE FROM stock_movements WHERE tenant_id = $1", [b.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
      // With it, a real business's records still cannot be deleted.
      await client.exec("BEGIN");
      await client.query("SELECT set_config('bizora.remove_sample', 'on', true)");
      await expect(client.query("DELETE FROM journal_lines WHERE tenant_id = $1", [a.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
      await client.exec("ROLLBACK");
      await client.exec("BEGIN");
      await client.query("SELECT set_config('bizora.remove_sample', 'on', true)");
      await expect(client.query("UPDATE journal_lines SET memo = 'changed' WHERE tenant_id = $1", [b.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
      await client.exec("ROLLBACK");
      await client.exec("BEGIN");
      await client.query("SELECT set_config('bizora.remove_sample', 'on', true)");
      await client.query("DELETE FROM journal_lines WHERE tenant_id = $1", [b.tenantId]);
      await client.query("DELETE FROM stock_movements WHERE tenant_id = $1", [b.tenantId]);
      await client.exec("ROLLBACK");
      expect((await client.query("SELECT count(*)::int AS n FROM stock_movements WHERE tenant_id = $1", [b.tenantId])).rows[0]).toEqual({ n: 1 });
    });
  });
});

function binary(res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}

/** Reads the ZIP by its central directory, so a wrong offset or size fails here. */
function readZip(data: Buffer) {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    expect(data.readUInt32LE(at)).toBe(0x02014b50);
    const size = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    files[name] = inflateRawSync(data.subarray(start, start + size)).toString("utf8");
    at += 46 + nameLength;
  }
  return files;
}

/** Parses the export's CSV (quotes, doubled quotes, CRLF), returning one object per row. */
function csv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\r") continue;
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  const [header, ...data] = rows;
  return data.map((values) => Object.fromEntries(header!.map((name, index) => [name, values[index]])) as Record<string, string | undefined>);
}
