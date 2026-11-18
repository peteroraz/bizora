import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { sha256Hex } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema, sessions } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";

const env: AppEnv = {
  NODE_ENV: "test",
  API_PORT: 3001,
  LOG_LEVEL: "error",
  DATABASE_URL: "postgres://bizora:bizora@localhost:5432/bizora_test",
  JWT_SECRET: "test-secret-must-be-at-least-32-chars",
  JWT_ACCESS_TTL: "15m",
  JWT_REFRESH_TTL: "7d",
  WEB_ORIGIN: "http://localhost:3000",
  COOKIE_SECURE: false,
  COOKIE_SAMESITE: "lax",
  THROTTLE_TTL_MS: 60_000,
  // A low limit: renewal must not be counted against it (every renewal from the web server shares one address).
  THROTTLE_AUTH_LIMIT: 3,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

describe("sprint 6f: staying signed in while working", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let http: Parameters<typeof request>[0];
  let refreshToken = "";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const owner = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "owner@renewal.test",
        password,
        displayName: "Owner",
        organizationName: "Renewal Shop",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    refreshToken = owner.body.data.refreshToken as string;
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  const renew = (token: string) => request(http).post("/api/v1/auth/refresh").send({ refreshToken: token });

  it("renews many times in a row without hitting the sign-in rate limit", async () => {
    for (let round = 0; round < 6; round += 1) {
      const renewed = await renew(refreshToken).expect(201);
      refreshToken = renewed.body.data.refreshToken as string;
      await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${renewed.body.data.accessToken}`).expect(200);
    }
  });

  it("accepts the same token twice at once, as one browser does when several requests find the pass expired", async () => {
    const [first, second] = await Promise.all([renew(refreshToken), renew(refreshToken)]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    for (const result of [first, second]) {
      await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${result.body.data.accessToken}`).expect(200);
    }
    // Both sessions belong to one sign-in, so the account page lists it once.
    const security = await request(http).get("/api/v1/auth/security").set("authorization", `Bearer ${first.body.data.accessToken}`).expect(200);
    expect(security.body.data.sessions).toHaveLength(1);
    expect(security.body.data.sessions[0].current).toBe(true);
    refreshToken = first.body.data.refreshToken as string;
  });

  it("still ends the whole sign-in when an old token comes back after the grace", async () => {
    const renewed = await renew(refreshToken).expect(201);
    const [old] = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, sha256Hex(refreshToken)));
    // Swapped a minute ago: a copy used now is a stolen one.
    await db.update(sessions).set({ revokedAt: new Date(Date.now() - 60_000) }).where(eq(sessions.id, old!.id));
    await renew(refreshToken).expect(401);
    await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${renewed.body.data.accessToken}`).expect(401);
    await renew(renewed.body.data.refreshToken as string).expect(401);
  });

  it("signing out ends the sign-in, including a session made in the grace", async () => {
    const login = await request(http).post("/api/v1/auth/login").send({ email: "owner@renewal.test", password }).expect(201);
    const token = login.body.data.refreshToken as string;
    const [first, second] = await Promise.all([renew(token), renew(token)]);
    await request(http).post("/api/v1/auth/logout").set("authorization", `Bearer ${first.body.data.accessToken}`).expect(201);
    await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${second.body.data.accessToken}`).expect(401);
    await renew(second.body.data.refreshToken as string).expect(401);
  });

  it("does not accept a token after sign-out, even inside the grace", async () => {
    const login = await request(http).post("/api/v1/auth/login").send({ email: "owner@renewal.test", password }).expect(201);
    const token = login.body.data.refreshToken as string;
    const renewed = await renew(token).expect(201);
    await request(http).post("/api/v1/auth/logout").set("authorization", `Bearer ${renewed.body.data.accessToken}`).expect(201);
    await renew(token).expect(401);
  });
});
