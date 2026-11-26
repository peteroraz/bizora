import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import { uuidv7 } from "@bizora/contracts";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { fakeGoogle } from "./test-admin-oidc.js";
import { auth, product, shop, staff, type Shop } from "./test-support.js";

const ADMIN = "http://admin.bizora.test";
const NOTE = "Card chargebacks reported by three customers; checking receipts";

describe("ADR-071: Bizora suspends and reinstates a business", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let google: Awaited<ReturnType<typeof fakeGoogle>>;
  let boss = "";
  let ops = "";
  let helper = "";
  let owner: Shop;
  let other: Shop;
  let cashier = "";
  let riceId = "";
  const as = (cookie: string) => ({ cookie, "x-bizora-admin": "1" });
  const lifecycleUrl = (id: string) => `/api/admin/v1/businesses/${id}`;
  const sale = () => ({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] });

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
    owner = await shop(http, "owner-suspended@bizora.test", "Quick Phones Ltd");
    other = await shop(http, "owner-fine@bizora.test", "Honest Provisions");
    riceId = await product(http, owner.token, "Rice 50kg", "7500000", "10", "bag");
    cashier = await staff(http, owner, "cashier-suspended@bizora.test", "CASHIER");
    boss = await google.signIn(http, "boss@bizora.test", "g-boss");
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "ops@bizora.test", name: "Ops", roles: ["operations"] }).expect(201);
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "helper@bizora.test", name: "Helper", roles: ["support"] }).expect(201);
    ops = await google.signIn(http, "ops@bizora.test", "g-ops");
    helper = await google.signIn(http, "helper@bizora.test", "g-helper");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await google?.close();
  });

  it("only operations and super admins suspend, always with a category and a reason", async () => {
    await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(helper)).send({ reasonCode: "fraud", reason: NOTE }).expect(403);
    const noReason = await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(boss)).send({ reasonCode: "fraud", reason: "x" }).expect(400);
    expect(noReason.body.error.code).toBe("VALIDATION_FAILED");
    await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(boss)).send({ reasonCode: "because", reason: NOTE }).expect(400);
    // The portal's own cross-site protection applies too.
    await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set("cookie", boss).send({ reasonCode: "fraud", reason: NOTE }).expect(403);
    // An old portal sign-in is not enough.
    await client.query("UPDATE admin_sessions SET created_at = now() - interval '20 minutes' WHERE staff_id = (SELECT id FROM admin_staff WHERE email = 'ops@bizora.test')");
    const stale = await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(ops)).send({ reasonCode: "fraud", reason: NOTE }).expect(403);
    expect(stale.body.error.code).toBe("SIGN_IN_AGAIN");
    ops = await google.signIn(http, "ops@bizora.test", "g-ops");

    const done = await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(boss)).send({ reasonCode: "fraud", reason: NOTE, caseRef: "CASE-17" }).expect(200);
    expect(done.body.data.lifecycle).toMatchObject({ hold: "suspended", reasonCode: "fraud", suspendedBy: "boss@bizora.test" });
    expect(done.body.data.lifecycle.reviewOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(done.body.data.lifecycle.events[0]).toMatchObject({ from: "none", to: "suspended", note: NOTE, caseRef: "CASE-17", by: "boss@bizora.test" });
    const again = await request(http).post(`${lifecycleUrl(owner.tenantId)}/suspend`).set(as(ops)).send({ reasonCode: "abuse", reason: NOTE }).expect(409);
    expect(again.body.error.code).toBe("ALREADY_SUSPENDED");
  });

  it("lets the owner read and download, and nothing else, from any session", async () => {
    expect((await request(http).get("/api/v1/sales").set(auth(owner.token)).expect(200)).body.data).toBeDefined();
    await request(http).get("/api/v1/exports/business").set(auth(owner.token)).expect(200);
    const refused = await request(http).post("/api/v1/sales").set(auth(owner.token)).send(sale()).expect(403);
    expect(refused.body.error.code).toBe("BUSINESS_SUSPENDED");
    expect(refused.body.error.message).toMatch(/still see and download/);
    await request(http).patch(`/api/v1/businesses/${owner.businessId}`).set(auth(owner.token)).send({ name: "Renamed" }).expect(403);

    // The app learns why, with the category only: the investigation note never reaches the business.
    const me = await request(http).get("/api/v1/auth/me").set(auth(owner.token)).expect(200);
    expect(me.body.data.organization).toMatchObject({ bizoraHold: "suspended", holdReasonCode: "fraud" });
    expect(JSON.stringify(me.body)).not.toContain("chargebacks");
    const notes = await request(http).get("/api/v1/notifications").set(auth(owner.token)).expect(200);
    expect(notes.body.data.items.map((item: { kind: string }) => item.kind)).toContain("business.suspended");
    const support = await request(http).get("/api/v1/support-activity").set(auth(owner.token)).expect(200);
    expect(JSON.stringify(support.body)).not.toContain("chargebacks");
  });

  it("stops staff completely, including work queued offline, which stays on the phone", async () => {
    const read = await request(http).get("/api/v1/sales").set(auth(cashier)).expect(403);
    expect(read.body.error.code).toBe("BUSINESS_SUSPENDED");
    expect(read.body.error.message).toMatch(/Ask the owner/);
    // The cashier's app can still load who they are, so it can say what happened.
    expect((await request(http).get("/api/v1/auth/me").set(auth(cashier)).expect(200)).body.data.organization.bizoraHold).toBe("suspended");
    const op = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), ...sale(), provisionalNumber: "DEV9-000001", soldAt: new Date().toISOString() } };
    await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [op] }).expect(403);
    const counted = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sales WHERE tenant_id = $1", [owner.tenantId]);
    expect(counted.rows[0]?.n).toBe(0);
    const held = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1", [owner.tenantId]);
    expect(held.rows[0]?.n).toBe(0);
    // Another business is not touched.
    await request(http).get("/api/v1/sales").set(auth(other.token)).expect(200);
    expect((await request(http).get("/api/v1/auth/me").set(auth(other.token)).expect(200)).body.data.organization.bizoraHold).toBe("none");
  });

  it("keeps every change in an append-only log, in the staff log, and in the business's log without the note", async () => {
    await expect(client.query("UPDATE business_lifecycle_events SET note = 'changed later' WHERE tenant_id = $1", [owner.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(client.query("DELETE FROM business_lifecycle_events WHERE tenant_id = $1", [owner.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
    const staffLog = await client.query<{ reason: string }>("SELECT reason FROM admin_audit WHERE action = 'business.suspended' AND tenant_id = $1", [owner.tenantId]);
    expect(staffLog.rows).toEqual([{ reason: NOTE }]);
    const ownerLog = await client.query<{ metadata_json: string; actor_type: string }>("SELECT metadata_json, actor_type FROM audit_events WHERE action = 'business.suspended' AND tenant_id = $1", [owner.tenantId]);
    expect(ownerLog.rows[0]?.actor_type).toBe("BIZORA_SUPPORT");
    expect(ownerLog.rows[0]?.metadata_json).not.toContain("chargebacks");
    // The database refuses a suspension without a known category.
    await expect(client.query("UPDATE organizations SET hold_reason_code = 'whatever' WHERE id = $1", [owner.tenantId])).rejects.toThrow(/organizations_bizora_hold_ck/);
  });

  it("is lifted by a second person for fraud, after which work queued offline arrives once", async () => {
    const same = await request(http).post(`${lifecycleUrl(owner.tenantId)}/reinstate`).set(as(boss)).send({ reason: "Receipts checked, all genuine" }).expect(403);
    expect(same.body.error.code).toBe("SECOND_PERSON_NEEDED");
    await request(http).post(`${lifecycleUrl(owner.tenantId)}/reinstate`).set(as(helper)).send({ reason: "Receipts checked, all genuine" }).expect(403);
    const lifted = await request(http).post(`${lifecycleUrl(owner.tenantId)}/reinstate`).set(as(ops)).send({ reason: "Receipts checked, all genuine" }).expect(200);
    expect(lifted.body.data.lifecycle).toMatchObject({ hold: "none", reasonCode: null });
    expect(lifted.body.data.lifecycle.events.map((event: { to: string }) => event.to)).toEqual(["none", "suspended"]);
    await request(http).post(`${lifecycleUrl(owner.tenantId)}/reinstate`).set(as(ops)).send({ reason: "Receipts checked, all genuine" }).expect(409);

    // The phone tries again: the sale it kept is recorded once.
    const op = { id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), ...sale(), provisionalNumber: "DEV9-000002", soldAt: new Date().toISOString() } };
    expect((await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [op] }).expect(200)).body.data.results[0].status).toBe("applied");
    expect((await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [op] }).expect(200)).body.data.results[0].status).toBe("duplicate");
    await request(http).post("/api/v1/sales").set(auth(owner.token)).send(sale()).expect(201);
    const notes = await request(http).get("/api/v1/notifications").set(auth(owner.token)).expect(200);
    expect(notes.body.data.items.map((item: { kind: string }) => item.kind)).toContain("business.reinstated");
  });

  it("lets the same person lift a suspension that was not for fraud or security", async () => {
    await request(http).post(`${lifecycleUrl(other.tenantId)}/suspend`).set(as(ops)).send({ reasonCode: "payment_dispute", reason: "Bank asked us to pause while they check" }).expect(200);
    await request(http).post(`${lifecycleUrl(other.tenantId)}/reinstate`).set(as(ops)).send({ reason: "Bank finished checking" }).expect(200);
    const viewer = await request(http).get(`${lifecycleUrl(other.tenantId)}/lifecycle`).set("cookie", helper).expect(200);
    expect(viewer.body.data.lifecycle.events).toHaveLength(2);
  });
});
