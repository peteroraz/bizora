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
  THROTTLE_AUTH_LIMIT: 3,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  // Several staff are invited; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};


import { ApiError, ErrorEnvelopeFilter } from "./common/errors.js";
import { safePath } from "./logging.js";
import { PostgresThrottlerStorage } from "./modules/telemetry/postgres-throttler.storage.js";

describe("sprint 8a: ready for real shops", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let one: INestApplication;
  let two: INestApplication;
  const logger = Object.assign(createLogger("silent"), {});

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    // Two API servers on one database, as Cloud Run runs them when busy.
    one = await createApp(env, db, logger);
    two = await createApp(env, db, logger);
    await one.init();
    await two.init();
  });

  afterAll(async () => {
    await one?.close();
    await two?.close();
    await client?.close();
  });

  it("counts sign-in attempts across every API server", async () => {
    const attempt = (app: INestApplication) => request(app.getHttpServer()).post("/api/v1/auth/login").send({ email: "nobody@limits.test", password: "wrong-password-123" });
    expect((await attempt(one)).status).toBe(401);
    expect((await attempt(two)).status).toBe(401);
    expect((await attempt(one)).status).toBe(401);
    // The fourth try, on either server, is refused.
    const refused = await attempt(two);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    const stored = await client.query<{ hits: number }>("SELECT hits FROM throttle_hits WHERE key LIKE 'default:%'");
    expect(stored.rows.some((row) => row.hits === 4)).toBe(true);
  });

  it("starts counting again once the window and the block have passed", async () => {
    const storage = new PostgresThrottlerStorage(db as never);
    const first = await storage.increment("k1", 1_000, 1, 1_000, "t");
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    const second = await storage.increment("k1", 1_000, 1, 1_000, "t");
    expect(second).toMatchObject({ totalHits: 2, isBlocked: true });
    expect(second.timeToBlockExpire).toBeGreaterThan(0);
    await client.query("UPDATE throttle_hits SET window_ends_at = now() - interval '1 second', blocked_until = now() - interval '1 second' WHERE key = 't:k1'");
    expect(await storage.increment("k1", 1_000, 1, 1_000, "t")).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it("sends server faults to Error Reporting with the business affected, never caller mistakes or link tokens", () => {
    const seen: Record<string, unknown>[] = [];
    const filter = new ErrorEnvelopeFilter({ error: (entry: Record<string, unknown>) => void seen.push(entry) } as never);
    const response = { status: () => response, json: () => response } as never;
    const host = (tenantContext: unknown) =>
      ({
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => ({ method: "GET", originalUrl: "/api/v1/sales/abc?x=1", headers: { "user-agent": "test" }, correlationId: "c-1", tenantContext }),
        }),
      }) as never;
    filter.catch(new Error("database went away"), host({ userId: "u-1", tenantId: "t-1", businessId: "b-1", branchId: "s-1" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
      serviceContext: { service: "bizora-api" },
      context: { httpRequest: { method: "GET", url: "/api/v1/sales/abc", responseStatusCode: 500 }, user: "u-1" },
      tenantId: "t-1",
      businessId: "b-1",
      branchId: "s-1",
      correlationId: "c-1",
    });
    expect(String(seen[0]?.message)).toMatch(/^Error: database went away\n\s+at /);
    // A caller's mistake is not a fault.
    filter.catch(new ApiError("VALIDATION_ERROR", "Enter a name.", 400), host(undefined));
    expect(seen).toHaveLength(1);
    expect(safePath("/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345/pdf?download=1")).toBe("/r/:token/pdf");
  });

  it("takes browser errors and blocked-content reports, and marks API answers as never runnable", async () => {
    const server = one.getHttpServer();
    await request(server)
      .post("/api/v1/telemetry/client-errors")
      .send({ kind: "error", message: "Cannot read properties of undefined", stack: "TypeError: Cannot read properties of undefined\n    at render (/_next/static/chunks/app.js:1:200)", url: "/app/sales/new" })
      .expect(204);
    await request(server).post("/api/v1/telemetry/client-errors").send({ kind: "nonsense" }).expect(204);
    await request(server)
      .post("/api/v1/telemetry/csp")
      .set("content-type", "application/csp-report")
      .send(JSON.stringify({ "csp-report": { "document-uri": "https://x.test/app", "violated-directive": "script-src", "blocked-uri": "https://evil.test/a.js" } }))
      .expect(204);
    const health = await request(server).get("/health").expect(200);
    expect(health.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(health.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
