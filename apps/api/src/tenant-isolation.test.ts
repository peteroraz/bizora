import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logging.js";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
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
};

describe("tenant isolation", () => {
  let app: INestApplication;
  let client: PGlite;
  let tenantAToken = "";
  let tenantBBusinessId = "";

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
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
    tenantBBusinessId = tenantB.body.data.tenant.businessId as string;
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

  it("ignores a client-supplied tenant header for another organization", async () => {
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${tenantAToken}`)
      .set("x-organization-id", "00000000-0000-4000-8000-000000000099")
      .set("x-tenant-id", "00000000-0000-4000-8000-000000000099")
      .expect(200);

    expect(me.body.data.tenant.tenantId).not.toBe("00000000-0000-4000-8000-000000000099");
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

  it("exposes health without secrets", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/JWT_SECRET|password|DATABASE_URL/i);
    expect(response.body.data.status).toBe("ok");
  });
});
