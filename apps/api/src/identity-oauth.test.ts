import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { sha256Hex } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema, auditEvents, authTokens, sessions, userIdentities, users } from "./db/schema.js";
import { applySqlBatches, loadMigrationSql } from "./db/sql.js";
import { newId } from "./common/ids.js";
import { createLogger } from "./logging.js";
import { ConsoleEmailAdapter } from "./modules/email/console-email.adapter.js";
import { EMAIL } from "./tokens.js";

const password = "LocalOnly!Passw0rd";

type PendingCode = {
  challenge: string;
  nonce: string;
  email: string;
  verified: boolean;
  sub: string;
  fault: string;
  used: boolean;
  omitEmail: boolean;
  preferredUsername: string;
};

describe("email recovery and OIDC sign-in", () => {
  let app: INestApplication;
  let email: ConsoleEmailAdapter;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let server: ReturnType<typeof createServer>;
  let issuer = "";
  let privateKey: CryptoKey;
  const codes = new Map<string, PendingCode>();
  let sequence = 0;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    jwk.use = "sig";

    server = createServer(async (req, res) => {
      try {
        await handleOidc(req, res, jwk);
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "server_error" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    issuer = `http://127.0.0.1:${address.port}/`;

    const client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
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
      EMAIL_PROVIDER: "console",
      GOOGLE_OAUTH_CLIENT_ID: "google-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-test-secret",
      GOOGLE_OAUTH_ISSUER: issuer,
    };
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    email = app.get(EMAIL);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function nextSub(label: string) {
    sequence += 1;
    return `${label}-${sequence}`;
  }

  async function handleOidc(req: IncomingMessage, res: ServerResponse, jwk: Record<string, unknown>) {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json(res, 200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        email: url.searchParams.get("email") ?? "ada@bizora.test",
        verified: url.searchParams.get("verified") !== "0",
        sub: url.searchParams.get("sub") ?? "subject-default",
        fault: url.searchParams.get("fault") ?? "",
        used: false,
        omitEmail: url.searchParams.get("omit_email") === "1",
        preferredUsername: url.searchParams.get("preferred_username") ?? "",
      });
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? `${issuer}callback`);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: redirect.href });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const pending = codes.get(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      if (!pending || pending.used || s256(verifier) !== pending.challenge) {
        if (pending) pending.used = true;
        json(res, 400, { error: "invalid_grant" });
        return;
      }
      pending.used = true;
      const now = Math.floor(Date.now() / 1000);
      const expired = pending.fault === "expired";
      const exp = expired ? now - 3600 : now + 600;
      const idToken = await new SignJWT({
        ...(pending.omitEmail ? {} : { email: pending.email, email_verified: pending.verified }),
        ...(pending.preferredUsername ? { preferred_username: pending.preferredUsername } : {}),
        name: "Ada Lovelace",
        nonce: pending.fault === "nonce" ? "not-the-nonce" : pending.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setSubject(pending.sub)
        .setAudience(pending.fault === "audience" ? "wrong-client" : (body.get("client_id") ?? ""))
        .setIssuedAt(expired ? exp - 60 : now)
        .setExpirationTime(exp)
        .sign(privateKey);
      json(res, 200, { access_token: "access-token", token_type: "Bearer", expires_in: 600, id_token: idToken });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  async function register(address: string, organizationName = "Ada Foods") {
    const response = await request(app.getHttpServer()).post("/api/v1/auth/register").send({
      email: address,
      password,
      displayName: "Ada",
      organizationName,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode: "general-retail",
    });
    expect(response.status).toBe(201);
    return response.body.data as { accessToken: string; refreshToken: string };
  }

  async function start(provider: "google", query: Record<string, string>) {
    const response = await request(app.getHttpServer()).get(`/api/v1/auth/oauth/${provider}/start`).query(query);
    return response;
  }

  async function complete(
    provider: "google",
    query: Record<string, string>,
    claims: {
      email: string;
      verified?: boolean;
      sub: string;
      fault?: string;
      omitEmail?: boolean;
      preferredUsername?: string;
    },
    mutate?: (callback: URL) => void,
  ) {
    const started = await start(provider, query);
    expect(started.status).toBe(302);
    const cookie = cookiePair(started.headers["set-cookie"], "bizora_oauth");
    expect(cookie).toBeTruthy();
    const authorize = new URL(started.headers.location as string);
    authorize.searchParams.set("sub", claims.sub);
    if (claims.omitEmail) authorize.searchParams.set("omit_email", "1");
    else authorize.searchParams.set("email", claims.email);
    if (claims.preferredUsername) authorize.searchParams.set("preferred_username", claims.preferredUsername);
    if (claims.verified === false) authorize.searchParams.set("verified", "0");
    if (claims.fault) authorize.searchParams.set("fault", claims.fault);
    const redirected = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(redirected.headers.get("location") ?? "");
    mutate?.(callback);
    const finished = await request(app.getHttpServer())
      .get(`${callback.pathname}${callback.search}`)
      .set("cookie", cookie ?? "");
    return { started, finished, cookie: cookie ?? "" };
  }

  it("rejects a bad state, nonce, audience, expiry, and a replayed code", async () => {
    const badState = await complete("google", { returnTo: "/app" }, { email: "state@bizora.test", sub: nextSub("state") }, (callback) => {
      callback.searchParams.set("state", "not-the-state");
    });
    expect(badState.finished.status).toBe(302);
    expect(badState.finished.headers.location).toContain("/login?reason=oauth");

    for (const fault of ["nonce", "audience", "expired"] as const) {
      const rejected = await complete(
        "google",
        { returnTo: "/app" },
        { email: `${fault}@bizora.test`, sub: nextSub(fault), fault },
      );
      expect(rejected.finished.status, fault).toBe(302);
      expect(rejected.finished.headers.location, fault).toContain("/login?reason=oauth");
    }

    const replay = await complete("google", { returnTo: "/app" }, { email: "replay@bizora.test", sub: nextSub("replay") });
    expect(replay.finished.headers.location).toBe("/setup");
    const callback = new URL(replay.finished.request.url);
    const second = await request(app.getHttpServer())
      .get(`${callback.pathname}${callback.search}`)
      .set("cookie", replay.cookie);
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain("/login?reason=oauth");
  });

  it("rejects an unverified provider instead of creating an account", async () => {
    const created = await complete("google", { returnTo: "/app" }, {
      email: "unverified-new@bizora.test",
      verified: false,
      sub: nextSub("unverified-new"),
    });
    expect(created.finished.status).toBe(302);
    expect(created.finished.headers.location).toContain("/login?reason=email");
    const rows = await db.select().from(users).where(eq(users.email, "unverified-new@bizora.test"));
    expect(rows).toHaveLength(0);
  });

  it("clears a pre-registered password and revokes that user's sessions when a verified provider takes the email", async () => {
    const registered = await register("preempted@bizora.test", "Preempted Foods");
    const [attacker] = await db.select().from(users).where(eq(users.email, "preempted@bizora.test"));
    expect(attacker?.passwordHash).toBeTruthy();
    await db.insert(userIdentities).values({
      id: newId(),
      userId: attacker!.id,
      provider: "planted",
      providerSubject: "planted-attacker-subject",
      email: "preempted@bizora.test",
    });

    const taken = await complete("google", { returnTo: "/app" }, {
      email: "preempted@bizora.test",
      sub: nextSub("victim"),
    });
    expect(taken.finished.headers.location).toBe("/app");

    const [user] = await db.select().from(users).where(eq(users.email, "preempted@bizora.test"));
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerifiedAt).toBeTruthy();
    const identities = await db.select().from(userIdentities).where(eq(userIdentities.userId, attacker!.id));
    expect(identities.map((item) => item.provider)).toEqual(["google"]);
    const revoked = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, attacker!.id), isNull(sessions.revokedAt)));
    expect(revoked).toHaveLength(1);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "identity.takeover_protection"));
    expect(audit?.entityId).toBe(attacker!.id);

    const passwordLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "preempted@bizora.test", password });
    expect(passwordLogin.status).toBe(401);
    const refresh = await request(app.getHttpServer()).post("/api/v1/auth/refresh").send({ refreshToken: registered.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("does not treat preferred_username as a verified email", async () => {
    const created = await complete("google", { returnTo: "/app" }, {
      email: "unused@bizora.test",
      omitEmail: true,
      preferredUsername: "display-only@bizora.test",
      sub: nextSub("preferred"),
    });
    expect(created.finished.status).toBe(302);
    expect(created.finished.headers.location).toContain("/login?reason=oauth");
    const byName = await db.select().from(users).where(eq(users.email, "display-only@bizora.test"));
    const byEmail = await db.select().from(users).where(eq(users.email, "unused@bizora.test"));
    expect(byName).toHaveLength(0);
    expect(byEmail).toHaveLength(0);
  });

  it("returns 404 for the removed Microsoft sign-in route", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/auth/oauth/microsoft/start").query({ returnTo: "/app" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("OAUTH_DISABLED");
    const callback = await request(app.getHttpServer()).get("/api/v1/auth/oauth/microsoft/callback");
    expect(callback.status).toBe(404);
    const providers = await request(app.getHttpServer()).get("/api/v1/auth/providers");
    expect(providers.body.data).toEqual({ google: true });
  });

  it("does not auto-link an unverified email and does auto-link a verified one", async () => {
    await register("linked@bizora.test");
    const verifyMessage = email.delivered.find((message) => message.to === "linked@bizora.test" && message.subject.includes("Verify"));
    const verifyToken = new URL(verifyMessage?.text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/missing").searchParams.get("token");
    const verifiedEmail = await request(app.getHttpServer()).post("/api/v1/auth/email/verify").send({ token: verifyToken });
    expect(verifiedEmail.status).toBe(201);

    const unverified = await complete("google", { returnTo: "/app" }, {
      email: "linked@bizora.test",
      verified: false,
      sub: nextSub("unverified"),
    });
    expect(unverified.finished.headers.location).toContain("/login?reason=link");

    const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email: "linked@bizora.test", password });
    expect(login.status).toBe(201);
    const before = await request(app.getHttpServer())
      .get("/api/v1/auth/security")
      .set("authorization", `Bearer ${login.body.data.accessToken}`);
    expect(before.body.data.identities).toEqual([]);

    const verified = await complete("google", { returnTo: "/app" }, {
      email: "linked@bizora.test",
      sub: nextSub("verified"),
    });
    expect(verified.finished.headers.location).toBe("/app");
    const after = await request(app.getHttpServer())
      .get("/api/v1/auth/security")
      .set("authorization", `Bearer ${login.body.data.accessToken}`);
    expect(after.body.data.identities).toHaveLength(1);
    expect(after.body.data.identities[0].provider).toBe("google");
    const stillPassword = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email: "linked@bizora.test", password });
    expect(stillPassword.status).toBe(201);
  });

  it("rejects an invitation when the provider email does not match", async () => {
    const owner = await register("owner-invite@bizora.test", "Invite Foods");
    const invited = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${owner.accessToken}`)
      .send({ email: "guest@bizora.test", role: "SALES" });
    expect(invited.status).toBe(201);
    const token = invited.body.data.invitation.token as string;
    const mismatch = await complete(
      "google",
      { returnTo: "/invite", intent: "invite", token },
      { email: "someone-else@bizora.test", sub: nextSub("invite") },
    );
    expect(mismatch.finished.headers.location).toContain("/login?reason=invite");

    const accepted = await request(app.getHttpServer()).post("/api/v1/invitations/accept").send({
      token,
      displayName: "Guest",
      password,
    });
    expect(accepted.status).toBe(201);
  });

  it("refuses to unlink the last sign-in method", async () => {
    const created = await complete("google", { returnTo: "/app" }, { email: "oauth-only@bizora.test", sub: nextSub("only") });
    expect(created.finished.headers.location).toBe("/setup");
    const access = cookieValue(created.finished.headers["set-cookie"], "bizora_session");
    const blocked = await request(app.getHttpServer())
      .post("/api/v1/auth/identities/google/unlink")
      .set("authorization", `Bearer ${access}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("LAST_SIGN_IN_METHOD");

    const set = await request(app.getHttpServer())
      .post("/api/v1/auth/password")
      .set("authorization", `Bearer ${access}`)
      .send({ newPassword: password });
    expect(set.status).toBe(201);
    const removed = await request(app.getHttpServer())
      .post("/api/v1/auth/identities/google/unlink")
      .set("authorization", `Bearer ${access}`);
    expect(removed.status).toBe(201);
    const missing = await request(app.getHttpServer())
      .post("/api/v1/auth/identities/google/unlink")
      .set("authorization", `Bearer ${access}`);
    expect(missing.status).toBe(404);
  });

  it("resets a password once, expires tokens, revokes sessions, and hides unknown emails", async () => {
    const registered = await register("reset@bizora.test", "Reset Foods");
    const verifyMessage = email.delivered.find((message) => message.to === "reset@bizora.test" && message.subject.includes("Verify"));
    const verifyToken = new URL(verifyMessage?.text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/missing").searchParams.get("token");
    const verified = await request(app.getHttpServer()).post("/api/v1/auth/email/verify").send({ token: verifyToken });
    expect(verified.status).toBe(201);
    const secondVerify = await request(app.getHttpServer()).post("/api/v1/auth/email/verify").send({ token: verifyToken });
    expect(secondVerify.status).toBe(400);
    const me = await request(app.getHttpServer()).get("/api/v1/auth/me").set("authorization", `Bearer ${registered.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.emailVerifiedAt).toEqual(expect.any(String));

    const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email: "reset@bizora.test", password });
    expect(login.status).toBe(201);
    const refreshToken = login.body.data.refreshToken as string;

    const known = await request(app.getHttpServer()).post("/api/v1/auth/password/forgot").send({ email: "reset@bizora.test" });
    const unknown = await request(app.getHttpServer()).post("/api/v1/auth/password/forgot").send({ email: "nobody@bizora.test" });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body.data).toEqual(known.body.data);
    expect(unknown.body.error).toBeUndefined();
    expect(email.delivered.filter((message) => message.to === "nobody@bizora.test")).toHaveLength(0);

    const resetMessage = email.delivered.find((message) => message.to === "reset@bizora.test" && message.subject.includes("Reset"));
    const token = new URL(resetMessage?.text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/missing").searchParams.get("token");
    expect(token).toBeTruthy();

    const first = await request(app.getHttpServer()).post("/api/v1/auth/password/reset").send({ token, password: "LocalOnly!Reset1" });
    expect(first.status).toBe(201);
    const reused = await request(app.getHttpServer()).post("/api/v1/auth/password/reset").send({ token, password: "LocalOnly!Reset2" });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe("RESET_INVALID");

    const refresh = await request(app.getHttpServer()).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(refresh.status).toBe(401);

    const again = await request(app.getHttpServer()).post("/api/v1/auth/password/forgot").send({ email: "reset@bizora.test" });
    expect(again.status).toBe(201);
    const expiredMessage = [...email.delivered].reverse().find((message) => message.subject.includes("Reset"));
    const expiredToken = new URL(expiredMessage?.text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/missing").searchParams.get("token");
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(authTokens.tokenHash, sha256Hex(expiredToken ?? "")));
    const expired = await request(app.getHttpServer())
      .post("/api/v1/auth/password/reset")
      .send({ token: expiredToken, password: "LocalOnly!Reset3" });
    expect(expired.status).toBe(400);
  });

  it("rejects open redirects before sending the browser to the provider", async () => {
    for (const returnTo of ["https://evil.example", "//evil.example", "/\\evil.example", "/%2F%2Fevil.example"]) {
      const response = await start("google", { returnTo });
      expect(response.status, returnTo).toBe(400);
      expect(response.body.error.code).toBe("REDIRECT_REJECTED");
      expect(response.headers.location).toBeUndefined();
    }
    const allowed = await start("google", { returnTo: "/app" });
    expect(allowed.status).toBe(302);
    expect(String(allowed.headers.location)).toContain("127.0.0.1");
  });
});

describe("microsoft identity migration", () => {
  it("stops when a microsoft identity exists and leaves the row in place", async () => {
    const db = new PGlite();
    try {
      const migrations = await loadMigrationSql();
      const migration = migrations.find((entry) => entry.id.startsWith("0010"));
      expect(migration).toBeTruthy();
      for (const prior of migrations.filter((entry) => entry.id < "0010")) {
        await applySqlBatches((statement) => db.exec(statement), prior.sql);
      }
      await db.exec(
        `INSERT INTO users (id, email, password_hash, display_name) VALUES ('77777777-7777-4777-8777-777777777777', 'ms@bizora.test', 'hash', 'Ms User')`,
      );
      await db.exec(
        `INSERT INTO user_identities (id, user_id, provider, provider_subject, email) VALUES ('88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777', 'microsoft', 'ms-subject', 'ms@bizora.test')`,
      );

      await db.exec("BEGIN");
      await expect(applySqlBatches((statement) => db.exec(statement), migration!.sql)).rejects.toThrow(
        /microsoft identities exist and were not deleted/,
      );
      await db.exec("ROLLBACK");

      const rows = await db.query<{ provider: string }>(`SELECT provider FROM user_identities`);
      expect(rows.rows.map((row) => row.provider)).toEqual(["microsoft"]);
    } finally {
      await db.close();
    }
  });
});

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

function cookiePair(header: string | string[] | undefined, name: string) {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.find((item) => item.startsWith(`${name}=`))?.split(";")[0];
}

function cookieValue(header: string | string[] | undefined, name: string) {
  const pair = cookiePair(header, name);
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}
