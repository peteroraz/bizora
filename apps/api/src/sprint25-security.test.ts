import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, signAccessToken } from "@bizora/auth";
import type { INestApplication } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { createApp } from "./bootstrap.js";
import { auditEvents, branches, businesses, invitations, memberships, schema, sessions } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { newId } from "./common/ids.js";

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
  TRUST_PROXY: true,
};

function decode(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    sub: string;
    sid: string;
    org?: string;
    mid?: string;
    bid?: string | null;
    br?: string | null;
    typ: "access" | "preauth";
  };
}

describe("sprint 2.5 security", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerToken = "";
  let tenantId = "";
  let businessAId = "";
  let businessBId = "";
  let branchAId = "";
  let branchBId = "";
  let ownerRefresh = "";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();

    const owner = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "owner@tenant-a.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Owner",
        organizationName: "Tenant A Foods",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      });
    ownerToken = owner.body.data.accessToken as string;
    ownerRefresh = owner.body.data.refreshToken as string;
    tenantId = owner.body.data.tenant.tenantId as string;
    businessAId = owner.body.data.tenant.businessId as string;
    branchAId = owner.body.data.tenant.branchId as string;

    businessBId = newId();
    branchBId = newId();
    await db.insert(businesses).values({
      id: businessBId,
      tenantId,
      name: "Business B",
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    });
    await db.insert(branches).values({
      id: branchBId,
      tenantId,
      businessId: businessBId,
      name: "Branch B",
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets an organization owner invite into Business A or Business B", async () => {
    const intoA = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "into-a@tenant-a.test", role: "SALES", businessId: businessAId })
      .expect(201);
    expect(intoA.body.data.invitation.businessId).toBe(businessAId);

    const intoB = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "into-b@tenant-a.test", role: "SALES", businessId: businessBId })
      .expect(201);
    expect(intoB.body.data.invitation.businessId).toBe(businessBId);
  });

  it("derives businessId when an org-wide owner invites with only branchId", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "branch-only@tenant-a.test", role: "SALES", branchId: branchBId });
    expect(created.status).not.toBe(500);
    expect(created.status).toBe(201);
    expect(created.body.data.invitation.branchId).toBe(branchBId);
    expect(created.body.data.invitation.businessId).toBe(businessBId);
  });

  it("keeps the selected Business B on the token after refresh", async () => {
    const selected = await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: tenantId, businessId: businessBId, branchId: branchBId })
      .expect(201);
    expect(decode(selected.body.data.accessToken as string).bid).toBe(businessBId);
    ownerToken = selected.body.data.accessToken as string;
    const rotated = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: selected.body.data.refreshToken })
      .expect(201);
    expect(decode(rotated.body.data.accessToken as string).bid).toBe(businessBId);
    expect(decode(rotated.body.data.accessToken as string).br).toBe(branchBId);
    ownerToken = rotated.body.data.accessToken as string;
    ownerRefresh = rotated.body.data.refreshToken as string;
  });

  it("auto-selects the only business on login, matching register", async () => {
    const registered = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: "solo-biz@tenant-s.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Solo",
        organizationName: "Solo Org",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    const registerBid = decode(registered.body.data.accessToken as string).bid;
    expect(registerBid).toBeTruthy();
    const loggedIn = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "solo-biz@tenant-s.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    expect(decode(loggedIn.body.data.accessToken as string).bid).toBe(registerBid);
  });

  it("ignores same-tenant business headers and keeps session scope", async () => {
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${ownerToken}`)
      .set("x-business-id", businessAId)
      .set("x-branch-id", branchAId)
      .expect(200);
    expect(me.body.data.tenant.businessId).toBe(businessBId);
    expect(me.body.data.tenant.branchId).toBe(branchBId);
  });

  it("auto-selects the only business on select-context when omitted", async () => {
    const solo = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: "picker@tenant-p.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Picker",
        organizationName: "Picker Org",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    const soloOrg = solo.body.data.tenant.tenantId as string;
    const soloBid = solo.body.data.tenant.businessId as string;

    const invite = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "picker@tenant-p.test", role: "SALES" })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token: invite.body.data.invitation.token, displayName: "Picker" })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "picker@tenant-p.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    expect(login.body.data.needsWorkspaceSelection).toBe(true);

    const single = await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ organizationId: soloOrg })
      .expect(201);
    expect(decode(single.body.data.accessToken as string).bid).toBe(soloBid);

    const dual = await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${single.body.data.accessToken}`)
      .send({ organizationId: tenantId })
      .expect(201);
    expect(decode(dual.body.data.accessToken as string).bid ?? null).toBeNull();
  });

  it("auto-selects the only branch for a business-scoped membership", async () => {
    const invite = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "biz-scoped@tenant-a.test", role: "SALES", businessId: businessAId })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: invite.body.data.invitation.token,
        displayName: "Biz Scoped",
        password: "LocalOnly!Passw0rd",
      })
      .expect(201);
    const loggedIn = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "biz-scoped@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    expect(decode(loggedIn.body.data.accessToken as string).bid).toBe(businessAId);
    expect(decode(loggedIn.body.data.accessToken as string).br).toBe(branchAId);
  });

  it("rotates refresh tokens with at most one winner", async () => {
    const minted = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const token = minted.body.data.refreshToken as string;
    const results = await Promise.all(
      [0, 1].map(() => request(app.getHttpServer()).post("/api/v1/auth/refresh").send({ refreshToken: token })),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 401)).toHaveLength(1);
  });

  it("records an audit event when an invitation is resent", async () => {
    const session = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    ownerToken = session.body.data.accessToken as string;

    const created = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "resend-audit@tenant-a.test", role: "SALES" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/invitations/${created.body.data.invitation.id}/resend`)
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(201);
    const events = await db.select().from(auditEvents);
    expect(events.some((event) => event.action === "invitation.resent")).toBe(true);
  });

  it("uses the forwarded client IP when trust proxy is enabled", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("x-forwarded-for", "203.0.113.50")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const events = await db.select().from(auditEvents);
    expect(events.some((event) => event.action === "identity.login" && event.ip === "203.0.113.50")).toBe(true);
  });

  it("blocks business and branch invitation escalation inside the tenant", async () => {
    const session = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    ownerToken = session.body.data.accessToken as string;

    const bizAdmin = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "biz-admin@tenant-a.test", role: "ADMINISTRATOR", businessId: businessAId })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: bizAdmin.body.data.invitation.token,
        displayName: "Biz Admin",
        password: "LocalOnly!Passw0rd",
      })
      .expect(201);
    const bizLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "biz-admin@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const bizToken = bizLogin.body.data.accessToken as string;

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${bizToken}`)
      .send({ email: "other-biz@tenant-a.test", role: "SALES", businessId: businessBId })
      .expect(403);

    const branchAdmin = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        email: "branch-admin@tenant-a.test",
        role: "ADMINISTRATOR",
        businessId: businessAId,
        branchId: branchAId,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: branchAdmin.body.data.invitation.token,
        displayName: "Branch Admin",
        password: "LocalOnly!Passw0rd",
      })
      .expect(201);
    const branchLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "branch-admin@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const branchToken = branchLogin.body.data.accessToken as string;

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${branchToken}`)
      .send({ email: "other-branch@tenant-a.test", role: "SALES", branchId: branchBId })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${branchToken}`)
      .send({ email: "widen@tenant-a.test", role: "SALES", businessId: businessAId })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${businessAId}`)
      .set("authorization", `Bearer ${branchToken}`)
      .send({ countryCode: "GB", baseCurrencyCode: "GBP" })
      .expect(403);
  });

  it("rejects a branch that belongs to another business", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        email: "mismatch@tenant-a.test",
        role: "SALES",
        businessId: businessAId,
        branchId: branchBId,
      })
      .expect(403);
  });

  it("rejects forged roles, malformed claims, and the wrong signing secret", async () => {
    const payload = decode(ownerToken);
    const forgedRole = await signAccessToken(
      {
        sub: payload.sub,
        sid: payload.sid,
        typ: "access",
        org: payload.org,
        mid: payload.mid,
        bid: payload.bid ?? null,
        br: payload.br ?? null,
        role: "OWNER",
      },
      env.JWT_SECRET,
      "1h",
    );
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${forgedRole}`)
      .expect(200);

    const malformed = await signAccessToken(
      {
        sub: payload.sub,
        sid: payload.sid,
        typ: "access",
        org: payload.org,
        mid: payload.mid,
        bid: payload.bid ?? null,
        br: payload.br ?? null,
      },
      env.JWT_SECRET,
      "1h",
    );
    const [h, p, s] = malformed.split(".");
    const body = JSON.parse(Buffer.from(p, "base64url").toString());
    body.sub = "nope";
    const bad = `${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${s}`;
    await request(app.getHttpServer()).get("/api/v1/auth/me").set("authorization", `Bearer ${bad}`).expect(401);

    const wrongSecret = await signAccessToken(
      {
        sub: payload.sub,
        sid: payload.sid,
        typ: "access",
        org: payload.org,
        mid: payload.mid,
        bid: payload.bid ?? null,
        br: payload.br ?? null,
      },
      "other-secret-must-be-at-least-32-chars",
      "1h",
    );
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${wrongSecret}`)
      .expect(401);
  });

  it("rejects expired access tokens and revoked sessions", async () => {
    const payload = decode(ownerToken);
    const expired = await signAccessToken(
      {
        sub: payload.sub,
        sid: payload.sid,
        typ: "access",
        org: payload.org,
        mid: payload.mid,
        bid: payload.bid ?? null,
        br: payload.br ?? null,
      },
      env.JWT_SECRET,
      Math.floor(Date.now() / 1000) - 30,
    );
    await request(app.getHttpServer()).get("/api/v1/auth/me").set("authorization", `Bearer ${expired}`).expect(401);

    const extra = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const extraToken = extra.body.data.accessToken as string;
    await request(app.getHttpServer()).post("/api/v1/auth/logout").set("authorization", `Bearer ${extraToken}`).expect(201);
    await request(app.getHttpServer()).get("/api/v1/auth/me").set("authorization", `Bearer ${extraToken}`).expect(401);
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const first = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: ownerRefresh })
      .expect(201);
    const rotated = first.body.data.refreshToken as string;
    expect(rotated).not.toBe(ownerRefresh);

    await request(app.getHttpServer()).post("/api/v1/auth/refresh").send({ refreshToken: ownerRefresh }).expect(401);

    const expiredLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, sha256Hex(expiredLogin.body.data.refreshToken as string)));
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, row.id));
    await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: expiredLogin.body.data.refreshToken })
      .expect(401);
  });

  it("handles invitation replay, revoke, expiry, and concurrent accept", async () => {
    const session = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    ownerToken = session.body.data.accessToken as string;

    const created = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "once@tenant-a.test", role: "SALES" })
      .expect(201);
    const token = created.body.data.invitation.token as string;

    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token, displayName: "Once", password: "LocalOnly!Passw0rd" })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({ token, displayName: "Once", password: "LocalOnly!Passw0rd" })
      .expect(400);

    const revocable = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "revoke-me@tenant-a.test", role: "SALES" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/invitations/${revocable.body.data.invitation.id}/revoke`)
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: revocable.body.data.invitation.token,
        displayName: "Nope",
        password: "LocalOnly!Passw0rd",
      })
      .expect(400);

    const expiring = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "expire@tenant-a.test", role: "SALES" })
      .expect(201);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, expiring.body.data.invitation.id));
    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: expiring.body.data.invitation.token,
        displayName: "Late",
        password: "LocalOnly!Passw0rd",
      })
      .expect(400);

    const concurrent = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ email: "race@tenant-a.test", role: "SALES" })
      .expect(201);
    const raceToken = concurrent.body.data.invitation.token as string;
    const results = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .post("/api/v1/invitations/accept")
          .send({ token: raceToken, displayName: "Race", password: "LocalOnly!Passw0rd" }),
      ),
    );
    const successes = results.filter((result) => result.status === 201);
    expect(successes.length).toBe(1);
  });

  it("denies login when every membership is suspended", async () => {
    const solo = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: "suspended-only@tenant-z.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Zed",
        organizationName: "Tenant Z",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    await db.update(memberships).set({ status: "SUSPENDED" }).where(eq(memberships.id, solo.body.data.tenant.membershipId));
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "suspended-only@tenant-z.test", password: "LocalOnly!Passw0rd" })
      .expect(403);
  });
});
