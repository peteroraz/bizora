import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { applySqlBatches, loadMigrationSql } from "./db/sql.js";
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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
};

const lagos = {
  line1: "12 Broad Street",
  city: "Lagos",
  countryCode: "NG",
  subdivisionCode: "NG-LA",
  postalCode: "100001",
};

describe("geography and addresses", () => {
  let app: INestApplication;
  let client: PGlite;
  let tenantAToken = "";
  let tenantBToken = "";
  let tenantBBusinessId = "";

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await applySqlBatches((statement) => client.exec(statement), migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    const tenantA = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "alice@geo.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Alice",
        organizationName: "Geo A",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    const tenantB = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "bob@geo.test",
        password: "LocalOnly!Passw0rd",
        displayName: "Bob",
        organizationName: "Geo B",
        countryCode: "GB",
        baseCurrencyCode: "GBP",
        timezone: "Europe/London",
      })
      .expect(201);
    tenantAToken = tenantA.body.data.accessToken as string;
    tenantBToken = tenantB.body.data.accessToken as string;
    tenantBBusinessId = tenantB.body.data.tenant.businessId as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("serves the full country list and Nigerian subdivisions to signed-in users", async () => {
    await request(app.getHttpServer()).get("/api/v1/reference/countries").expect(401);
    const countries = await request(app.getHttpServer())
      .get("/api/v1/reference/countries")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(200);
    expect(countries.headers["cache-control"]).toContain("private");
    expect(countries.body.data.items.length).toBeGreaterThanOrEqual(249);
    const nigeria = countries.body.data.items.find((item: { code: string }) => item.code === "NG");
    expect(nigeria.defaultCurrencyCode).toBe("NGN");
    expect(nigeria.timezones[0]).toBe("Africa/Lagos");
    expect(nigeria.subdivisionRequired).toBe(true);

    const states = await request(app.getHttpServer())
      .get("/api/v1/reference/countries/NG/subdivisions")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(200);
    expect(states.body.data.items).toHaveLength(37);
    expect(states.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "NG-LA", name: "Lagos" })]),
    );
    const uk = await request(app.getHttpServer())
      .get("/api/v1/reference/countries/GB/subdivisions")
      .set("authorization", `Bearer ${tenantAToken}`)
      .expect(200);
    expect(uk.body.data.items.map((item: { code: string }) => item.code).sort()).toEqual([
      "GB-ENG",
      "GB-NIR",
      "GB-SCT",
      "GB-WLS",
    ]);
  });

  it("rejects a subdivision or postal code that does not match the country", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/addresses")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ line1: "12 Broad Street", city: "Lagos", countryCode: "NG" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/v1/addresses")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, subdivisionCode: "US-NY" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/v1/addresses")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, postalCode: "12" })
      .expect(400);
  });

  it("hides addresses across tenants and rejects cross-tenant links", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/addresses")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send(lagos)
      .expect(201);
    const addressId = created.body.data.address.id as string;

    await request(app.getHttpServer())
      .get(`/api/v1/addresses/${addressId}`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/addresses/${addressId}`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .send({ ...lagos, line1: "Taken" })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${tenantBBusinessId}`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .send({ addressId })
      .expect(404);

    await expect(
      client.exec(`UPDATE businesses SET address_id = '${addressId}' WHERE id = '${tenantBBusinessId}'`),
    ).rejects.toThrow();

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/addresses/${addressId}`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, line1: "14 Marina" })
      .expect(200);
    expect(updated.body.data.address.line1).toBe("14 Marina");
  });
});
