import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { memberships, schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";

const password = "LocalOnly!Passw0rd";

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

const publicFields = ["branchName", "businessName", "organizationId", "organizationName", "role"];

type WorkspaceRow = {
  organizationId: string;
  organizationName: string;
  role: string;
  businessName: string | null;
  branchName: string | null;
};

function claims(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    typ?: string;
    org?: string;
  };
}

describe("GET /api/v1/auth/workspaces", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let aliceAccessToken = "";
  let aliceOrgId = "";
  let preauthToken = "";
  let bobOrgId = "";
  let gammaOrgId = "";
  let betaMembershipId = "";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();

    const alice = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "alice@workspaces.test",
        password,
        displayName: "Alice",
        organizationName: "Alpha Goods",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    aliceAccessToken = alice.body.data.accessToken as string;
    aliceOrgId = alice.body.data.tenant.tenantId as string;

    const bob = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "bob@workspaces.test",
        password,
        displayName: "Bob",
        organizationName: "Beta Studio",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    bobOrgId = bob.body.data.tenant.tenantId as string;

    const carol = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "carol@workspaces.test",
        password,
        displayName: "Carol",
        organizationName: "Gamma Isolated",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    gammaOrgId = carol.body.data.tenant.tenantId as string;

    const invited = await request(http)
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${bob.body.data.accessToken}`)
      .send({
        email: "alice@workspaces.test",
        role: "EMPLOYEE",
        businessId: bob.body.data.tenant.businessId,
        branchId: bob.body.data.tenant.branchId,
      })
      .expect(201);

    const accepted = await request(http)
      .post("/api/v1/invitations/accept")
      .send({ token: invited.body.data.invitation.token, displayName: "Alice" })
      .expect(201);
    betaMembershipId = accepted.body.data.membershipId as string;
    expect(betaMembershipId).toMatch(/^[0-9a-f-]{36}$/i);

    const login = await request(http)
      .post("/api/v1/auth/login")
      .send({ email: "alice@workspaces.test", password })
      .expect(201);
    expect(login.body.data.needsWorkspaceSelection).toBe(true);
    expect(login.body.data.tenant).toBeNull();
    preauthToken = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  function expectOnlyAliceOrgs(items: WorkspaceRow[]) {
    expect(items).toHaveLength(2);
    const ids = items.map((item) => item.organizationId);
    expect(ids).toContain(aliceOrgId);
    expect(ids).toContain(bobOrgId);
    expect(ids).not.toContain(gammaOrgId);
    expect(items.map((item) => item.organizationName)).not.toContain("Gamma Isolated");
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(publicFields);
    }
  }

  it("rejects a caller with no session", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/auth/workspaces").expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("lists the caller's active memberships for a normal access session", async () => {
    expect(claims(aliceAccessToken).typ).toBe("access");
    expect(claims(aliceAccessToken).org).toBe(aliceOrgId);

    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/workspaces")
      .set("authorization", `Bearer ${aliceAccessToken}`)
      .set("x-organization-id", gammaOrgId)
      .expect(200);

    const items = response.body.data as WorkspaceRow[];
    expectOnlyAliceOrgs(items);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: aliceOrgId,
          organizationName: "Alpha Goods",
          role: "OWNER",
          businessName: null,
          branchName: null,
        }),
        expect.objectContaining({
          organizationId: bobOrgId,
          organizationName: "Beta Studio",
          role: "EMPLOYEE",
          businessName: "Beta Studio",
          branchName: "Main",
        }),
      ]),
    );
    expect(response.body.meta.correlationId).toBeTruthy();
  });

  it("lists the same memberships for a preauth selection session", async () => {
    expect(claims(preauthToken).typ).toBe("preauth");
    expect(claims(preauthToken).org).toBeUndefined();

    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/workspaces")
      .set("authorization", `Bearer ${preauthToken}`)
      .set("x-organization-id", gammaOrgId)
      .set("x-tenant-id", gammaOrgId)
      .expect(200);

    expectOnlyAliceOrgs(response.body.data as WorkspaceRow[]);
  });

  it("accepts the session cookie for both preauth and access sessions", async () => {
    const http = app.getHttpServer();
    const alice = request.agent(http);
    const login = await alice.post("/api/v1/auth/login").send({ email: "alice@workspaces.test", password }).expect(201);
    expect(claims(login.body.data.accessToken as string).typ).toBe("preauth");
    const fromCookie = await alice.get("/api/v1/auth/workspaces").expect(200);
    expectOnlyAliceOrgs(fromCookie.body.data as WorkspaceRow[]);

    const carol = request.agent(http);
    const carolLogin = await carol
      .post("/api/v1/auth/login")
      .send({ email: "carol@workspaces.test", password })
      .expect(201);
    expect(claims(carolLogin.body.data.accessToken as string).typ).toBe("access");
    const carolList = await carol.get("/api/v1/auth/workspaces").expect(200);
    expect(carolList.body.data).toEqual([
      expect.objectContaining({
        organizationId: gammaOrgId,
        organizationName: "Gamma Isolated",
        role: "OWNER",
      }),
    ]);
    expect(carolList.body.data.map((item: WorkspaceRow) => item.organizationId)).not.toContain(aliceOrgId);
    expect(carolList.body.data.map((item: WorkspaceRow) => item.organizationId)).not.toContain(bobOrgId);
  });

  it("keeps every active membership after the caller selects one workspace", async () => {
    const selected = await request(app.getHttpServer())
      .post("/api/v1/auth/select-context")
      .set("authorization", `Bearer ${preauthToken}`)
      .send({ organizationId: bobOrgId })
      .expect(201);
    const token = selected.body.data.accessToken as string;
    expect(claims(token).typ).toBe("access");
    expect(claims(token).org).toBe(bobOrgId);

    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/workspaces")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expectOnlyAliceOrgs(response.body.data as WorkspaceRow[]);
  });

  it("omits a membership that is no longer active", async () => {
    await db.update(memberships).set({ status: "SUSPENDED" }).where(eq(memberships.id, betaMembershipId));

    const response = await request(app.getHttpServer())
      .get("/api/v1/auth/workspaces")
      .set("authorization", `Bearer ${aliceAccessToken}`)
      .expect(200);
    const items = response.body.data as WorkspaceRow[];
    expect(items).toEqual([
      expect.objectContaining({
        organizationId: aliceOrgId,
        organizationName: "Alpha Goods",
        role: "OWNER",
      }),
    ]);
    expect(items.map((item) => item.organizationId)).not.toContain(bobOrgId);
    expect(items.map((item) => item.organizationId)).not.toContain(gammaOrgId);
  });
});
