import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logging.js";
import { createApp } from "./bootstrap.js";
import { memberships, schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import type { INestApplication } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";

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
};

describe("tenant isolation", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantAToken = "";
  let tenantABusinessId = "";
  let tenantABranchId = "";
  let tenantBBusinessId = "";
  let tenantBBranchId = "";
  let aliceMembershipId = "";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();

    const tenantA = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "alice@tenant-a.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Alice",
        organizationName: "Tenant A Foods",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect((res) => {
        if (res.status !== 201) {
          throw new Error(`register failed ${res.status}: ${JSON.stringify(res.body)}`);
        }
      });

    const tenantB = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "bob@tenant-b.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Bob",
        organizationName: "Tenant B Studio",
        countryCode: "GB",
        baseCurrencyCode: "GBP",
        timezone: "Europe/London",
      })
      .expect((res) => {
        if (res.status !== 201) {
          throw new Error(`register failed ${res.status}: ${JSON.stringify(res.body)}`);
        }
      });

    tenantAToken = tenantA.body.data.accessToken as string;
    tenantABusinessId = tenantA.body.data.tenant.businessId as string;
    tenantABranchId = tenantA.body.data.tenant.branchId as string;
    aliceMembershipId = tenantA.body.data.tenant.membershipId as string;
    tenantBBusinessId = tenantB.body.data.tenant.businessId as string;
    tenantBBranchId = tenantB.body.data.tenant.branchId as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("attaches server-derived tenant context to authenticated requests", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(200);

    expect(response.body.data.tenant.tenantId).toBeTruthy();
    expect(response.body.meta.correlationId).toBeTruthy();
    expect(response.headers["x-correlation-id"]).toBeTruthy();
  });

  it("returns 404 when Tenant A requests Tenant B business by id", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/businesses/${tenantBBusinessId}`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(404);

    expect(response.body.error.code).toBe("BUSINESS_NOT_FOUND");
    expect(response.body.error.correlationId).toBeTruthy();
  });

  it("returns 404 when Tenant A requests Tenant B branch by id", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/branches/${tenantBBranchId}`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(404);

    expect(response.body.error.code).toBe("BRANCH_NOT_FOUND");
  });

  it("returns 404 when Tenant A updates Tenant B business or branch", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${tenantBBusinessId}`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ name: "Hijacked" })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/v1/branches/${tenantBBranchId}`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ name: "Hijacked" })
      .expect(404);
  });

  it("ignores a client-supplied tenant header for another organization", async () => {
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .set("x-organization-id", "00000000-0000-4000-8000-000000000099")
      .set("x-tenant-id", "00000000-0000-4000-8000-000000000099")
      .expect(200);

    expect(me.body.data.tenant.tenantId).not.toBe("00000000-0000-4000-8000-000000000099");
  });

  it("rejects Tenant B business and branch ids in scope headers", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .set("x-business-id", tenantBBusinessId)
      .set("x-branch-id", tenantBBranchId)
      .expect(403);
  });

  it("rejects a token with a bad signature", async () => {
    const tampered = `${tenantAToken.slice(0, -6)}xxxxxx`;
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tampered}`)
      .expect(401);
  });

  it("refuses switching into another tenant", async () => {
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ organizationId: "00000000-0000-4000-8000-000000000099" })
      .expect(403);

    expect(me.body.data.tenant.tenantId).toBeTruthy();
  });

  it("does not default an org-wide invite onto the selected business", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ email: "orgwide@tenant-a.test", role: "SALES" })
      .expect(201);

    expect(created.body.data.invitation.businessId ?? null).toBeNull();
    expect(created.body.data.invitation.branchId ?? null).toBeNull();
  });

  it("rejects inviting a role higher than the inviter and IDs outside membership scope", async () => {
    const invited = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({
        email: "scoped-admin@tenant-a.test",
        role: "ADMINISTRATOR",
        businessId: tenantABusinessId,
        branchId: tenantABranchId,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: invited.body.data.invitation.token,
        displayName: "Scoped Admin",
        password: "LocalOnly!Passw0rd",
      })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "scoped-admin@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    const adminToken = login.body.data.accessToken as string;

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ email: "new-owner@tenant-a.test", role: "OWNER" })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${adminToken}`)
      .send({
        email: "cross@tenant-a.test",
        role: "SALES",
        businessId: tenantBBusinessId,
        branchId: tenantBBranchId,
      })
      .expect(403);
  });

  it("requires workspace selection when the user has multiple active memberships", async () => {
    const inviteAliceIntoB = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "bob@tenant-b.test", password: "LocalOnly!Passw0rd" })
      .expect(201);

    const bobToken = inviteAliceIntoB.body.data.accessToken as string;
    const invited = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${bobToken}`)
      .send({ email: "alice@tenant-a.test", role: "SALES" })
      .expect(201);

    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        token: invited.body.data.invitation.token,
        displayName: "Alice",
      })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "alice@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);

    expect(login.body.data.needsWorkspaceSelection).toBe(true);
    expect(login.body.data.tenant).toBeNull();
    expect(login.body.data.workspaces).toHaveLength(2);

    await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ organizationId: "00000000-0000-4000-8000-000000000099" })
      .expect(403);
  });

  it("rejects a token after the membership is suspended", async () => {
    await db
      .update(memberships)
      .set({ status: "SUSPENDED" })
      .where(eq(memberships.id, aliceMembershipId));

    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "alice@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201)
      .expect((res) => {
        // Alice now also has SALES in tenant B; login must not revive the suspended A membership.
        expect(res.body.data.tenant.membershipId).not.toBe(aliceMembershipId);
        expect(res.body.data.tenant.role).not.toBeUndefined();
      });
  });

  it("exposes health without secrets", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/JWT_SECRET|password|DATABASE_URL/i);
    expect(response.body.data.status).toBe("ok");
  });
});
