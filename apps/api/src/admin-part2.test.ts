import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import type { ConsoleEmailAdapter } from "./modules/email/console-email.adapter.js";
import { EMAIL } from "./tokens.js";

const password = "LocalOnly!Passw0rd";
const ADMIN = "http://admin.bizora.test";

type Pending = { challenge: string; nonce: string; email: string; verified: boolean; sub: string };

describe("ADR-039: Terms of use, support view, limits per business, owner sees Bizora support", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let oidc: ReturnType<typeof createServer>;
  let issuer = "";
  let privateKey: CryptoKey;
  const codes = new Map<string, Pending>();
  let env: AppEnv;

  let owner = { access: "", refresh: "" };
  let tenantId = "";
  let ownerId = "";
  let firstInviteToken = "";
  let boss = "";
  let helper = "";
  let watcher = "";

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const as = (cookie: string) => ({ cookie, "x-bizora-admin": "1" });

  async function handleOidc(req: IncomingMessage, res: ServerResponse, jwk: Record<string, unknown>) {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        email: url.searchParams.get("email") ?? "",
        verified: url.searchParams.get("verified") !== "0",
        sub: url.searchParams.get("sub") ?? "",
      });
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const pending = codes.get(body.get("code") ?? "");
      if (!pending || s256(body.get("code_verifier") ?? "") !== pending.challenge) return json(res, 400, { error: "invalid_grant" });
      codes.delete(body.get("code") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ email: pending.email, email_verified: pending.verified, name: pending.email.split("@")[0], nonce: pending.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setSubject(pending.sub)
        .setAudience(body.get("client_id") ?? "")
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privateKey);
      return json(res, 200, { access_token: "x", token_type: "Bearer", expires_in: 600, id_token: idToken });
    }
    res.writeHead(404);
    res.end();
  }

  /** Signs in to the portal through the fake Google; returns where the portal sent the browser and its cookie. */
  async function googleSignIn(address: string, sub: string, verified = true, transactionCookie?: string) {
    const started = await request(http).get("/api/admin/v1/auth/google/start").expect(302);
    const authorize = new URL(started.headers.location as string);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ADMIN}/api/admin/v1/auth/google/callback`);
    authorize.searchParams.set("email", address);
    authorize.searchParams.set("sub", sub);
    if (!verified) authorize.searchParams.set("verified", "0");
    const sealed = transactionCookie ?? pair(started.headers["set-cookie"], "bizora_admin_oauth");
    const redirected = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(redirected.headers.get("location") ?? "");
    const finished = await request(http).get(`${callback.pathname}${callback.search}`).set("cookie", sealed ?? "");
    expect(finished.status).toBe(302);
    return { location: finished.headers.location as string, cookie: pair(finished.headers["set-cookie"], "bizora_admin") ?? "" };
  }

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" };
    oidc = createServer((req, res) => void handleOidc(req, res, jwk).catch(() => json(res, 500, {})));
    await new Promise<void>((resolve) => oidc.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(oidc.address() as AddressInfo).port}/`;
    env = {
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
      GOOGLE_OAUTH_CLIENT_ID: "google-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-test-secret",
      GOOGLE_OAUTH_ISSUER: issuer,
      ADMIN_WEB_ORIGIN: ADMIN,
      ADMIN_BOOTSTRAP_EMAILS: " Boss@Bizora.test , not-an-email",
    };
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();

    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "ada@kanoshop.test", password, displayName: "Ada Owner", organizationName: "Kano Corner Shop", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = { access: registered.body.data.accessToken as string, refresh: registered.body.data.refreshToken as string };
    tenantId = registered.body.data.tenant.tenantId as string;
    ownerId = registered.body.data.user.id as string;
    const { businessId, branchId } = registered.body.data.tenant as { businessId: string; branchId: string };
    const invited = await request(http).post("/api/v1/invitations").set(auth(owner.access)).send({ email: "musa@kanoshop.test", role: "CASHIER", businessId, branchId }).expect(201);
    firstInviteToken = invited.body.data.invitation.token as string;
    await request(http).post("/api/v1/shop-devices").set(auth(owner.access)).send({ name: "Counter phone" }).expect(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await new Promise<void>((resolve) => oidc.close(() => resolve()));
  });

  let ops = "";
  let cashier = "";
  let customerId = "";

  it("asks owners to accept the Terms of use, and records who accepted which version", async () => {
    const me = await request(http).get("/api/v1/auth/me").set(auth(owner.access)).expect(200);
    expect(me.body.data).toMatchObject({ termsRequired: true, termsVersion: "2026-11-24" });
    await request(http).post("/api/v1/auth/accept-terms").set(auth(owner.access)).send({ version: "2020-01-01", accept: true }).expect(400);
    await request(http).post("/api/v1/auth/accept-terms").set(auth(owner.access)).send({ version: "2026-11-24" }).expect(400);
    await request(http).post("/api/v1/auth/accept-terms").set(auth(owner.access)).send({ version: "2026-11-24", accept: true }).expect(200);
    await request(http).post("/api/v1/auth/accept-terms").set(auth(owner.access)).send({ version: "2026-11-24", accept: true }).expect(200);
    expect((await request(http).get("/api/v1/auth/me").set(auth(owner.access)).expect(200)).body.data.termsRequired).toBe(false);
    const rows = await client.query<{ method: string }>("SELECT method FROM terms_acceptances WHERE user_id = $1", [ownerId]);
    expect(rows.rows).toEqual([{ method: "in_app" }]);

    // Ticking the box on the sign-up form counts as accepting.
    const signedUp = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "zainab@lagos.test", password, displayName: "Zainab", organizationName: "Zainab Fabrics", countryCode: "NG", acceptTerms: true })
      .expect(201);
    expect((await request(http).get("/api/v1/auth/me").set(auth(signedUp.body.data.accessToken)).expect(200)).body.data.termsRequired).toBe(false);
    await request(http).post("/api/v1/auth/register").send({ email: "x@lagos.test", password, displayName: "X", organizationName: "X", countryCode: "NG", acceptTerms: false }).expect(400);

    // Staff work under their owner's acceptance.
    await request(http).post("/api/v1/invitations/accept").send({ token: firstInviteToken, displayName: "Musa", password }).expect(201);
    cashier = (await request(http).post("/api/v1/auth/login").send({ email: "musa@kanoshop.test", password }).expect(201)).body.data.accessToken as string;
    expect((await request(http).get("/api/v1/auth/me").set(auth(cashier)).expect(200)).body.data.termsRequired).toBe(false);
  });

  it("signs in staff with each role", async () => {
    boss = (await googleSignIn("boss@bizora.test", "g-boss")).cookie;
    for (const [address, roles] of [["helper@bizora.test", ["support"]], ["ops@bizora.test", ["operations"]], ["watcher@bizora.test", ["viewer"]]] as const) {
      await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: address, name: address, roles }).expect(201);
    }
    helper = (await googleSignIn("helper@bizora.test", "g-helper")).cookie;
    ops = (await googleSignIn("ops@bizora.test", "g-ops")).cookie;
    watcher = (await googleSignIn("watcher@bizora.test", "g-watcher")).cookie;
    expect([boss, helper, ops, watcher].every(Boolean)).toBe(true);
    const created = await request(http).post("/api/v1/customers").set(auth(owner.access)).send({ name: "Chidi Okafor", phone: "08031234567", email: "chidi@mail.test" }).expect(201);
    customerId = created.body.data.customer.id as string;
  });

  it("opens a support view only with a reason, for support and super admins, for one hour", async () => {
    await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/customers`).set("cookie", helper).expect(403);
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(helper)).send({ reason: "x" }).expect(400);
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(ops)).send({ reason: "Checking stock figures" }).expect(403);
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(watcher)).send({ reason: "Checking stock figures" }).expect(403);
    const opened = await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(helper)).send({ reason: "Owner says yesterday's cash is wrong" }).expect(201);
    const minutes = (Date.parse(opened.body.data.view.expiresAt) - Date.parse(opened.body.data.view.openedAt)) / 60_000;
    expect(Math.round(minutes)).toBe(60);
    expect((await request(http).get(`/api/admin/v1/businesses/${tenantId}/support-view`).set("cookie", helper).expect(200)).body.data.view.id).toBe(opened.body.data.view.id);
    // Each staff member opens their own.
    expect((await request(http).get(`/api/admin/v1/businesses/${tenantId}/support-view`).set("cookie", boss).expect(200)).body.data.view).toBeNull();
  });

  it("shows the business's records read-only, with customers' phones and emails partly hidden", async () => {
    const customers = await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/customers`).set("cookie", helper).expect(200);
    const chidi = (customers.body.data.data.items as { id: string; name: string; phoneE164?: string; phone?: string; email?: string }[]).find((item) => item.id === customerId);
    expect(chidi?.name).toBe("Chidi Okafor");
    expect(JSON.stringify(customers.body.data)).not.toContain("1234567");
    expect(JSON.stringify(customers.body.data)).not.toContain("chidi@mail.test");
    expect(JSON.stringify(customers.body.data)).toContain("c***@mail.test");
    for (const page of ["sales", "stock", "debtors", "money", "activity"]) {
      await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/${page}`).set("cookie", helper).expect(200);
    }
    const money = await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/money`).set("cookie", helper).expect(200);
    expect(money.body.data.data.profit).toHaveProperty("profitMinor");
    expect(money.body.data.data.cash.shops).toHaveLength(1);
    await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/settings`).set("cookie", helper).expect(404);
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/records/sales`).set(as(helper)).send({}).expect(404);

    const staffLog = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_audit WHERE action = 'support.viewed' AND tenant_id = $1", [tenantId]);
    expect(staffLog.rows[0]?.n).toBe(7);
    const ownerLog = await client.query<{ actor_type: string; metadata_json: string }>("SELECT actor_type, metadata_json FROM audit_events WHERE tenant_id = $1 AND action = 'support.viewed'", [tenantId]);
    expect(ownerLog.rows).toHaveLength(7);
    expect(ownerLog.rows[0]?.actor_type).toBe("BIZORA_SUPPORT");
    expect(JSON.parse(ownerLog.rows[0]!.metadata_json)).toEqual({ staffEmail: "helper@bizora.test", reason: "Owner says yesterday's cash is wrong" });
  });

  it("closes the view after an hour, or when the staff member closes it", async () => {
    await client.query("UPDATE admin_support_views SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [tenantId]);
    const closed = await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/sales`).set("cookie", helper).expect(403);
    expect(closed.body.error.code).toBe("SUPPORT_VIEW_CLOSED");
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(boss)).send({ reason: "Checking a payment dispute" }).expect(201);
    await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/sales`).set("cookie", boss).expect(200);
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view/close`).set(as(boss)).expect(200);
    await request(http).get(`/api/admin/v1/businesses/${tenantId}/records/sales`).set("cookie", boss).expect(403);
  });

  it("sets limits for one business, which win over the plan until cleared", async () => {
    const before = await request(http).get(`/api/admin/v1/businesses/${tenantId}/limits`).set("cookie", watcher).expect(200);
    const staffLimit = before.body.data.limits.find((row: { limit: string }) => row.limit === "max_staff");
    expect(staffLimit).toMatchObject({ set: null, used: 1 });
    const body = { max_branches: null, max_staff: 1, max_devices: null, ai_daily_reads: 5, reason: "Trial business, keep it small" };
    await request(http).put(`/api/admin/v1/businesses/${tenantId}/limits`).set(as(helper)).send(body).expect(403);
    await request(http).put(`/api/admin/v1/businesses/${tenantId}/limits`).set(as(ops)).send({ ...body, reason: "" }).expect(400);
    const set = await request(http).put(`/api/admin/v1/businesses/${tenantId}/limits`).set(as(ops)).send(body).expect(200);
    expect(set.body.data.limits.find((row: { limit: string }) => row.limit === "max_staff")).toMatchObject({ set: 1, used: 1 });
    const me = (await request(http).get("/api/v1/auth/me").set(auth(owner.access)).expect(200)).body.data.tenant as { businessId: string; branchId: string };
    const refused = await request(http).post("/api/v1/invitations").set(auth(owner.access)).send({ email: "second@kanoshop.test", role: "CASHIER", businessId: me.businessId, branchId: me.branchId }).expect(402);
    expect(refused.body.error.code).toBe("PLAN_LIMIT");
    expect((await request(http).get("/api/v1/captures/status").set(auth(owner.access)).expect(200)).body.data.limit).toBe(5);

    await request(http).put(`/api/admin/v1/businesses/${tenantId}/limits`).set(as(boss)).send({ max_branches: null, max_staff: null, max_devices: null, ai_daily_reads: null, reason: "Trial over" }).expect(200);
    await request(http).post("/api/v1/invitations").set(auth(owner.access)).send({ email: "second@kanoshop.test", role: "CASHIER", businessId: me.businessId, branchId: me.branchId }).expect(201);
    const logged = await client.query<{ actor_type: string }>("SELECT actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'plan.limits_changed'", [tenantId]);
    expect(logged.rows.map((row) => row.actor_type)).toEqual(["BIZORA_SUPPORT", "BIZORA_SUPPORT"]);
  });

  it("tells the owner by email when support opens their records (ADR-042)", async () => {
    const mails = (app.get(EMAIL) as ConsoleEmailAdapter).delivered.filter((sent) => sent.kind === "support_access");
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails[0]!.text).toContain("Owner says yesterday's cash is wrong");
    expect(mails[0]!.text).toContain("read-only");
  });

  it("shows the owner what Bizora staff looked at and did, with who and why", async () => {
    const seen = await request(http).get("/api/v1/support-activity").set(auth(owner.access)).expect(200);
    const items = seen.body.data.items as { staffEmail: string; action: string; reason: string | null; page: string | null }[];
    expect(items.find((item) => item.action === "support.view_opened" && item.staffEmail === "helper@bizora.test")?.reason).toBe("Owner says yesterday's cash is wrong");
    expect(items.filter((item) => item.action === "support.viewed").map((item) => item.page)).toContain("customers");
    expect(items.some((item) => item.action === "business.limits_changed")).toBe(true);
    await request(http).get("/api/v1/support-activity").set(auth(cashier)).expect(403);
  });

  it("keeps support inside one business, read-only, and refuses forged or business sign-ins (ADR-043)", async () => {
    // A support view for one business does not open another's records.
    const other = await request(http).post("/api/v1/auth/register").send({ email: "second-owner@part2.test", password: "LocalOnly!Passw0rd", displayName: "Second", organizationName: "Second Shop", countryCode: "NG", acceptTerms: true }).expect(201);
    const otherTenant = other.body.data.tenant.tenantId as string;
    await request(http).post(`/api/admin/v1/businesses/${tenantId}/support-view`).set(as(helper)).send({ reason: "Checking a refund for the owner" }).expect(201);
    const crossed = await request(http).get(`/api/admin/v1/businesses/${otherTenant}/records/sales`).set("cookie", helper).expect(403);
    expect(crossed.body.error.code).toBe("SUPPORT_VIEW_CLOSED");
    // Support cannot change business records: there are no write routes, and business routes ignore the portal cookie.
    for (const page of ["customers", "sales", "stock", "money"]) {
      expect((await request(http).post(`/api/admin/v1/businesses/${tenantId}/records/${page}`).set(as(helper)).send({ name: "x" })).status).toBe(404);
      expect((await request(http).patch(`/api/admin/v1/businesses/${tenantId}/records/${page}`).set(as(helper)).send({ name: "x" })).status).toBe(404);
    }
    await request(http).post("/api/v1/customers").set("cookie", helper).send({ name: "Support hack" }).expect(401);
    await request(http).get("/api/v1/sales").set("cookie", boss).expect(401);
    // A business owner's sign-in never opens the portal, and a made-up portal cookie is refused.
    await request(http).get("/api/admin/v1/businesses").set(auth(owner.access)).expect(401);
    await request(http).get("/api/admin/v1/businesses").set("cookie", `bizora_admin=${randomBytes(32).toString("base64url")}`).expect(401);
    const tampered = helper.replace(/=(.)/, (_, first: string) => `=${first === "A" ? "B" : "A"}`);
    await request(http).get("/api/admin/v1/businesses").set("cookie", tampered).expect(401);
  });

  it("shows usage counts on the business page", async () => {
    const profile = await request(http).get(`/api/admin/v1/businesses/${tenantId}`).set("cookie", watcher).expect(200);
    expect(profile.body.data.usage).toEqual({ sales30Days: 0, products: 0, customers: 1 });
  });
});

function pair(header: unknown, name: string) {
  const list = Array.isArray(header) ? (header as string[]) : typeof header === "string" ? [header] : [];
  const found = list.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0]! : null;
}

function s256(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
