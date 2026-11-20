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
import { ConsoleEmailAdapter } from "./modules/email/console-email.adapter.js";
import { sealOauthTransaction } from "./modules/identity/oauth-cookie.js";
import { EMAIL } from "./tokens.js";

const password = "LocalOnly!Passw0rd";
const ADMIN = "http://admin.bizora.test";
const reason = { reason: "Owner asked on WhatsApp" };

type Pending = { challenge: string; nonce: string; email: string; verified: boolean; sub: string };

describe("sprint 8b: Admin portal part 1 (staff sign-in, finding businesses and people, support actions)", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let oidc: ReturnType<typeof createServer>;
  let issuer = "";
  let privateKey: CryptoKey;
  let email: ConsoleEmailAdapter;
  const codes = new Map<string, Pending>();
  let env: AppEnv;

  let owner = { access: "", refresh: "" };
  let tenantId = "";
  let ownerId = "";
  let invitationId = "";
  let firstInviteToken = "";
  let deviceId = "";
  let deviceToken = "";
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
    email = app.get(EMAIL);

    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "ada@kanoshop.test", password, displayName: "Ada Owner", organizationName: "Kano Corner Shop", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = { access: registered.body.data.accessToken as string, refresh: registered.body.data.refreshToken as string };
    tenantId = registered.body.data.tenant.tenantId as string;
    ownerId = registered.body.data.user.id as string;
    const { businessId, branchId } = registered.body.data.tenant as { businessId: string; branchId: string };
    const invited = await request(http).post("/api/v1/invitations").set(auth(owner.access)).send({ email: "musa@kanoshop.test", role: "CASHIER", businessId, branchId }).expect(201);
    invitationId = invited.body.data.invitation.id as string;
    firstInviteToken = invited.body.data.invitation.token as string;
    const enrolled = await request(http).post("/api/v1/shop-devices").set(auth(owner.access)).send({ name: "Counter phone" }).expect(201);
    deviceId = enrolled.body.data.device.id as string;
    deviceToken = pair(enrolled.headers["set-cookie"], "bizora_device") ?? "";
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await new Promise<void>((resolve) => oidc.close(() => resolve()));
  });

  it("lets in only allow-listed Google accounts; the first bootstrap email becomes a super admin", async () => {
    expect((await googleSignIn("stranger@gmail.test", "g-stranger")).location).toBe("/?error=not_allowed");
    expect((await googleSignIn("boss@bizora.test", "g-boss", false)).location).toBe("/?error=unverified");

    const signedIn = await googleSignIn("boss@bizora.test", "g-boss");
    expect(signedIn.location).toBe("/");
    expect(signedIn.cookie).toMatch(/^bizora_admin=/);
    boss = signedIn.cookie;
    const me = await request(http).get("/api/admin/v1/auth/me").set("cookie", boss).expect(200);
    expect(me.body.data).toMatchObject({ email: "boss@bizora.test", roles: ["super_admin"] });
    expect(me.body.data.abilities).toContain("staff.manage");

    // The Google account is pinned: the same email from another Google account is refused.
    expect((await googleSignIn("boss@bizora.test", "g-someone-else")).location).toBe("/?error=different_account");
    const refused = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_audit WHERE action = 'staff.sign_in_refused'");
    expect(refused.rows[0]?.n).toBe(3);
  });

  it("keeps the portal and business sign-ins apart", async () => {
    await request(http).get("/api/admin/v1/auth/me").set(auth(owner.access)).expect(401);
    await request(http).get("/api/admin/v1/businesses").set("cookie", `bizora_session=${owner.access}`).expect(401);
    await request(http).get("/api/v1/auth/me").set("cookie", boss).expect(401);
    // A business sign-in transaction cannot finish an admin sign-in.
    const forged = sealOauthTransaction({ provider: "google", state: "s", nonce: "n", codeVerifier: "v", returnTo: "/", intent: "login" }, env.JWT_SECRET);
    expect((await googleSignIn("boss@bizora.test", "g-boss", true, `bizora_admin_oauth=${forged}`)).location).toBe("/?error=expired");
  });

  it("refuses requests that did not come from the portal itself", async () => {
    await request(http).get("/api/admin/v1/businesses").set("cookie", boss).set("origin", "http://localhost:3000").expect(403);
    await request(http).get("/api/admin/v1/businesses").set("cookie", boss).set("sec-fetch-site", "same-site").expect(403);
    await request(http).get("/api/admin/v1/businesses").set("cookie", boss).set("origin", ADMIN).set("sec-fetch-site", "same-origin").expect(200);
    await request(http).post(`/api/admin/v1/devices/${deviceId}/stop`).set("cookie", boss).send(reason).expect(403);
    // The business app's address is never allowed to read admin answers from a browser.
    const preflight = await request(http).options("/api/admin/v1/businesses").set("origin", "http://localhost:3000").set("access-control-request-method", "GET");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const businessPreflight = await request(http).options("/api/v1/auth/me").set("origin", "http://localhost:3000").set("access-control-request-method", "GET");
    expect(businessPreflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("lets super admins keep the staff list, and roles decide what each person can do", async () => {
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "Helper@Bizora.test", name: "Helper", roles: ["support"] }).expect(201);
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "watcher@bizora.test", name: "Watcher", roles: ["viewer"] }).expect(201);
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "helper@bizora.test", name: "Again", roles: ["viewer"] }).expect(409);
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "x@bizora.test", name: "X", roles: ["owner"] }).expect(400);
    helper = (await googleSignIn("helper@bizora.test", "g-helper")).cookie;
    watcher = (await googleSignIn("watcher@bizora.test", "g-watcher")).cookie;
    expect(helper).toBeTruthy();
    expect(watcher).toBeTruthy();

    await request(http).get("/api/admin/v1/businesses").set("cookie", watcher).expect(200);
    await request(http).post(`/api/admin/v1/invitations/${invitationId}/resend`).set(as(watcher)).send(reason).expect(403);
    await request(http).get("/api/admin/v1/staff").set("cookie", watcher).expect(403);
    await request(http).get("/api/admin/v1/staff").set("cookie", helper).expect(403);
    await request(http).get("/api/admin/v1/audit").set("cookie", helper).expect(403);
    const list = await request(http).get("/api/admin/v1/staff").set("cookie", boss).expect(200);
    expect(list.body.data.map((row: { email: string }) => row.email)).toEqual(["boss@bizora.test", "helper@bizora.test", "watcher@bizora.test"]);
  });

  it("finds a business by its name, link name or owner email, and shows its account without its records", async () => {
    for (const q of ["kano corner", "Kano-corner".slice(0, 4), "ada@kanoshop"]) {
      const found = await request(http).get("/api/admin/v1/businesses").query({ q }).set("cookie", watcher).expect(200);
      expect(found.body.data[0]).toMatchObject({ id: tenantId, name: "Kano Corner Shop", plan: "business", openShops: 1, owner: { email: "ada@kanoshop.test" } });
    }
    expect((await request(http).get("/api/admin/v1/businesses").query({ q: "%" }).set("cookie", watcher).expect(200)).body.data).toEqual([]);

    const profile = await request(http).get(`/api/admin/v1/businesses/${tenantId}`).set("cookie", watcher).expect(200);
    const data = profile.body.data;
    expect(data.plan.code).toBe("business");
    expect(data.shops).toHaveLength(1);
    expect(data.shops[0]).toMatchObject({ status: "open", aiReadsToday: 0, aiReads30Days: 0 });
    expect(data.people[0]).toMatchObject({ email: "ada@kanoshop.test", role: "OWNER", signsInWith: "email" });
    expect(data.invitations[0]).toMatchObject({ id: invitationId, email: "musa@kanoshop.test", expired: false });
    expect(data.devices[0]).toMatchObject({ id: deviceId, name: "Counter phone", status: "active" });
    expect(data.storage).toEqual({ productPhotos: 0, bytes: 0 });
    expect(data.lastActivityAt).toBeTruthy();
    expect(JSON.stringify(data)).not.toMatch(/token|password|hash/i);
    await request(http).get("/api/admin/v1/businesses/not-a-uuid").set("cookie", watcher).expect(404);

    const viewed = await client.query<{ email: string }>("SELECT staff_email AS email FROM admin_audit WHERE action = 'business.viewed' AND tenant_id = $1", [tenantId]);
    expect(viewed.rows.map((row) => row.email)).toEqual(["watcher@bizora.test"]);
  });

  it("finds people and pending invitations by email", async () => {
    const found = await request(http).get("/api/admin/v1/people").query({ q: "kanoshop" }).set("cookie", helper).expect(200);
    expect(found.body.data.people).toEqual([expect.objectContaining({ id: ownerId, email: "ada@kanoshop.test", businesses: [expect.objectContaining({ tenantId, role: "OWNER" })] })]);
    expect(found.body.data.invitations).toEqual([expect.objectContaining({ id: invitationId, business: "Kano Corner Shop" })]);
    const person = await request(http).get(`/api/admin/v1/people/${ownerId}`).set("cookie", helper).expect(200);
    expect(person.body.data).toMatchObject({ email: "ada@kanoshop.test", signsInWith: ["password"], emailVerified: false });
    expect(person.body.data.signedInDevices).toBeGreaterThan(0);
  });

  it("resends an invitation with a fresh link, and the owner's log shows who did it and why", async () => {
    await request(http).post(`/api/admin/v1/invitations/${invitationId}/resend`).set(as(helper)).send({ reason: "no" }).expect(400);
    const before = email.delivered.length;
    await request(http).post(`/api/admin/v1/invitations/${invitationId}/resend`).set(as(helper)).send(reason).expect(200);
    expect(email.delivered.length).toBe(before + 1);
    expect(email.delivered.at(-1)?.to).toBe("musa@kanoshop.test");
    // The old link stops working.
    await request(http).post("/api/v1/invitations/accept").send({ token: firstInviteToken, displayName: "Musa", password }).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    const logged = await client.query<{ actor_type: string; actor_user_id: string | null; source: string; metadata_json: string }>(
      "SELECT actor_type, actor_user_id, source, metadata_json FROM audit_events WHERE tenant_id = $1 AND action = 'invitation.resent'",
      [tenantId],
    );
    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0]).toMatchObject({ actor_type: "BIZORA_SUPPORT", actor_user_id: null, source: "ADMIN_PORTAL" });
    expect(JSON.parse(logged.rows[0]!.metadata_json)).toEqual({ staffEmail: "helper@bizora.test", reason: reason.reason });
  });

  it("resends a verification email only while the address is unconfirmed", async () => {
    const before = email.delivered.length;
    await request(http).post(`/api/admin/v1/people/${ownerId}/resend-verification`).set(as(helper)).send(reason).expect(200);
    expect(email.delivered.length).toBe(before + 1);
    expect(email.delivered.at(-1)?.subject).toMatch(/verify/i);
    await client.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [ownerId]);
    await request(http).post(`/api/admin/v1/people/${ownerId}/resend-verification`).set(as(helper)).send(reason).expect(409);
  });

  it("stops a lost shop phone", async () => {
    await request(http).get("/api/v1/shop/device").set("cookie", deviceToken).expect(200);
    const stopped = await request(http).post(`/api/admin/v1/devices/${deviceId}/stop`).set(as(helper)).send({ reason: "Phone stolen from the counter" }).expect(200);
    expect(stopped.body.data.status).toBe("stopped");
    await request(http).get("/api/v1/shop/device").set("cookie", deviceToken).expect(401);
    const profile = await request(http).get(`/api/admin/v1/businesses/${tenantId}`).set("cookie", helper).expect(200);
    expect(profile.body.data.devices[0].status).toBe("stopped");
    expect(profile.body.data.supportHistory.map((entry: { action: string }) => entry.action)).toEqual(["device.stopped", "invitation.resent"]);
    // Stopping it again changes nothing and logs nothing new.
    await request(http).post(`/api/admin/v1/devices/${deviceId}/stop`).set(as(helper)).send(reason).expect(200);
    const rows = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'shop_device.revoked'", [tenantId]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("signs a person out everywhere", async () => {
    await request(http).post(`/api/admin/v1/people/${ownerId}/sign-out-everywhere`).set(as(helper)).send(reason).expect(200);
    const refreshed = await request(http).post("/api/v1/auth/refresh").send({ refreshToken: owner.refresh });
    expect(refreshed.status).toBe(401);
    const logged = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'user.signed_out_everywhere' AND actor_type = 'BIZORA_SUPPORT'", [tenantId]);
    expect(logged.rows[0]?.n).toBe(1);
  });

  it("always keeps one super admin, and removed staff are signed out and kept out", async () => {
    const list = (await request(http).get("/api/admin/v1/staff").set("cookie", boss).expect(200)).body.data as { id: string; email: string }[];
    const id = (address: string) => list.find((row) => row.email === address)!.id;
    await request(http).post(`/api/admin/v1/staff/${id("boss@bizora.test")}/remove`).set(as(boss)).send(reason).expect(409);
    await request(http).patch(`/api/admin/v1/staff/${id("boss@bizora.test")}`).set(as(boss)).send({ roles: ["viewer"], ...reason }).expect(409);
    await request(http).patch(`/api/admin/v1/staff/${id("watcher@bizora.test")}`).set(as(boss)).send({ roles: ["viewer", "finance"], ...reason }).expect(200);

    await request(http).post(`/api/admin/v1/staff/${id("watcher@bizora.test")}/remove`).set(as(boss)).send({ reason: "Left the company" }).expect(200);
    await request(http).get("/api/admin/v1/businesses").set("cookie", watcher).expect(401);
    expect((await googleSignIn("watcher@bizora.test", "g-watcher")).location).toBe("/?error=removed");
    // Added back later: their Google account is checked afresh.
    await request(http).post("/api/admin/v1/staff").set(as(boss)).send({ email: "watcher@bizora.test", name: "Watcher", roles: ["viewer"] }).expect(201);
    expect((await googleSignIn("watcher@bizora.test", "g-watcher-new")).location).toBe("/");
  });

  it("keeps a staff audit log with reasons, and signing out ends the session", async () => {
    const log = await request(http).get("/api/admin/v1/audit").set("cookie", boss).expect(200);
    const actions = (log.body.data as { action: string; reason: string | null; staffEmail: string }[]).map((entry) => entry.action);
    for (const action of ["staff.removed", "staff.roles_changed", "person.signed_out_everywhere", "device.stopped", "invitation.resent", "staff.added", "staff.bootstrapped"]) {
      expect(actions).toContain(action);
    }
    expect(log.body.data.find((entry: { action: string }) => entry.action === "staff.removed")).toMatchObject({ reason: "Left the company", staffEmail: "boss@bizora.test" });
    const forBusiness = await request(http).get("/api/admin/v1/audit").query({ tenantId }).set("cookie", boss).expect(200);
    expect(forBusiness.body.data.every((entry: { tenantId: string }) => entry.tenantId === tenantId)).toBe(true);

    const out = await request(http).post("/api/admin/v1/auth/sign-out").set(as(helper)).expect(200);
    expect(String(out.headers["set-cookie"])).toMatch(/bizora_admin=;/);
    await request(http).get("/api/admin/v1/auth/me").set("cookie", helper).expect(401);
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
