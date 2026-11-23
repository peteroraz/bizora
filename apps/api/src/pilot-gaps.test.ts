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
import { fakeGoogle } from "./test-admin-oidc.js";

const password = "LocalOnly!Passw0rd";

/** Pilot readiness items 4, 15 and 16: the cases the earlier suites did not cover. */
describe("pilot readiness: account recovery, support access and Admin portal boundaries", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let google: Awaited<ReturnType<typeof fakeGoogle>>;
  let boss = "";
  let owner = { token: "", tenantId: "" };

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
      // Low on purpose: the forgot-password limit is tested below. Every request here comes from one address.
      THROTTLE_AUTH_LIMIT: 6,
      INVITE_TOKEN_EXPOSE: false,
      TRUST_PROXY: false,
      DEFAULT_PLAN_CODE: "business",
      EMAIL_PROVIDER: "console",
      GOOGLE_OAUTH_CLIENT_ID: "google-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-test-secret",
      GOOGLE_OAUTH_ISSUER: google.issuer,
      ADMIN_WEB_ORIGIN: "http://admin.bizora.test",
      ADMIN_BOOTSTRAP_EMAILS: "boss@bizora.test",
    };
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@kano.test", password, displayName: "Owner", organizationName: "Kano Corner Shop", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    owner = { token: registered.body.data.accessToken as string, tenantId: registered.body.data.tenant.tenantId as string };
    await request(http).post("/api/v1/customers").set({ authorization: `Bearer ${owner.token}` }).send({ name: "Ada Obi", phone: "08031234567" }).expect(201);
    boss = await google.signIn(http, "boss@bizora.test", "g-boss");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await google?.close();
  });

  it("refuses a made-up or malformed reset link with the same answer, and changes nothing", async () => {
    const before = await client.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = 'owner@kano.test'");
    for (const token of ["a".repeat(43), "not-a-token", ""]) {
      const response = await request(http).post("/api/v1/auth/password/reset").send({ token, password: "LocalOnly!Other1" });
      expect(response.status, token).toBe(400);
    }
    const after = await client.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = 'owner@kano.test'");
    expect(after.rows).toEqual(before.rows);
  });

  it("limits support staff to reading: no route changes a business's records", async () => {
    const base = `/api/admin/v1/businesses/${owner.tenantId}`;
    await request(http).post(`${base}/support-view`).set({ cookie: boss, "x-bizora-admin": "1" }).send({ reason: "Owner asked about a customer" }).expect(201);
    const headers = { cookie: boss, "x-bizora-admin": "1" };
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const response = await request(http)[method](`${base}/records/customers`).set(headers).send({ name: "Changed by support" });
      expect([404, 405], method).toContain(response.status);
    }
    // Business routes do not accept an Admin portal session either.
    await request(http).post("/api/v1/customers").set(headers).send({ name: "Changed by support" }).expect(401);
    const names = await client.query<{ name: string }>("SELECT name FROM customers WHERE tenant_id = $1", [owner.tenantId]);
    expect(names.rows).toEqual([{ name: "Ada Obi" }]);
  });

  it("refuses a business owner's sign-in on every Admin portal route", async () => {
    const bearer = { authorization: `Bearer ${owner.token}`, "x-bizora-admin": "1" };
    for (const path of ["/api/admin/v1/auth/me", "/api/admin/v1/businesses?q=Kano", `/api/admin/v1/businesses/${owner.tenantId}`, "/api/admin/v1/staff", "/api/admin/v1/audit"]) {
      const response = await request(http).get(path).set(bearer);
      expect(response.status, path).toBe(401);
    }
    await request(http).post(`/api/admin/v1/businesses/${owner.tenantId}/support-view`).set(bearer).send({ reason: "Pretending to be support" }).expect(401);
  });

  // Last: it uses up this address's allowance.
  it("limits forgot-password requests per address, whether or not the email is known", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(http).post("/api/v1/auth/password/forgot").send({ email: attempt % 2 ? "owner@kano.test" : `nobody${attempt}@kano.test` });
      statuses.push(response.status);
      if (response.status === 429) expect(response.body.error.code).toBe("RATE_LIMITED");
    }
    expect(statuses.filter((status) => status === 201).length).toBeLessThanOrEqual(6);
    expect(statuses.at(-1)).toBe(429);
  });
});
