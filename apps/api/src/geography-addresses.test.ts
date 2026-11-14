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

async function inviteMember(
  http: ReturnType<INestApplication["getHttpServer"]>,
  ownerToken: string,
  input: { email: string; role: string; businessId?: string; branchId?: string },
) {
  const invited = await request(http)
    .post("/api/v1/invitations")
    .set("authorization", `Bearer ${ownerToken}`)
    .send(input)
    .expect(201);
  await request(http)
    .post("/api/v1/invitations/accept")
    .send({
      token: invited.body.data.invitation.token,
      displayName: "Invited Member",
      password: "LocalOnly!Passw0rd",
    })
    .expect(201);
  const login = await request(http)
    .post("/api/v1/auth/login")
    .send({ email: input.email, password: "LocalOnly!Passw0rd" })
    .expect(201);
  return login.body.data.accessToken as string;
}

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
  let tenantABusinessId = "";
  let tenantABranchId = "";
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
    tenantABusinessId = tenantA.body.data.tenant.businessId as string;
    tenantABranchId = tenantA.body.data.tenant.branchId as string;
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

  it("publishes the country list without a session and registers any country in that list", async () => {
    const http = app.getHttpServer();
    const published = await request(http).get("/api/v1/public/reference/countries").expect(200);
    expect(published.headers["cache-control"]).toContain("public");
    expect(published.headers["cache-control"]).toContain("max-age=86400");
    const items = published.body.data.items as {
      code: string;
      defaultCurrencyCode: string;
      timezones: string[];
      postalCodeRegex?: string;
    }[];
    expect(items.length).toBeGreaterThanOrEqual(249);
    expect(items.some((item) => "postalCodeRegex" in item)).toBe(false);
    const nigeria = items.find((item) => item.code === "NG");
    expect(nigeria?.defaultCurrencyCode).toBe("NGN");
    expect(nigeria?.timezones[0]).toBe("Africa/Lagos");

    for (const [index, code] of ["KE", "BR", "DE"].entries()) {
      const created = await request(http)
        .post("/api/v1/auth/register")
        .send({
          email: `${code.toLowerCase()}.${index}.${Date.now()}@geo.test`,
          password: "LocalOnly!Passw0rd",
          displayName: code,
          organizationName: `${code} Foods`,
          countryCode: code,
          baseCurrencyCode: "USD",
          timezone: "UTC",
        })
        .expect(201);
      const businesses = await request(http)
        .get("/api/v1/businesses")
        .set("authorization", `Bearer ${created.body.data.accessToken}`)
        .expect(200);
      expect(String(businesses.body.data.items[0].countryCode).trim()).toBe(code);
    }

    await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: `zz.${Date.now()}@geo.test`,
        password: "LocalOnly!Passw0rd",
        displayName: "ZZ",
        organizationName: "ZZ Foods",
        countryCode: "ZZ",
        baseCurrencyCode: "USD",
        timezone: "UTC",
      })
      .expect(400);

    const kenya = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: `kenya-defaults.${Date.now()}@geo.test`,
        password: "LocalOnly!Passw0rd",
        displayName: "Kenya Defaults",
        organizationName: "Kenya Defaults",
        countryCode: "KE",
      })
      .expect(201);
    const kenyaBusiness = await request(http)
      .get("/api/v1/businesses")
      .set("authorization", `Bearer ${kenya.body.data.accessToken}`)
      .expect(200);
    expect(String(kenyaBusiness.body.data.items[0].baseCurrencyCode).trim()).toBe("KES");
    expect(kenyaBusiness.body.data.items[0].timezone).toBe("Africa/Nairobi");

    const brazil = items.find((item) => item.code === "BR");
    const brazilRegister = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: `brazil-defaults.${Date.now()}@geo.test`,
        password: "LocalOnly!Passw0rd",
        displayName: "Brazil Defaults",
        organizationName: "Brazil Defaults",
        countryCode: "BR",
      })
      .expect(201);
    const brazilBusiness = await request(http)
      .get("/api/v1/businesses")
      .set("authorization", `Bearer ${brazilRegister.body.data.accessToken}`)
      .expect(200);
    expect(String(brazilBusiness.body.data.items[0].baseCurrencyCode).trim()).toBe(brazil?.defaultCurrencyCode);
    expect(brazilBusiness.body.data.items[0].timezone).toBe(brazil?.timezones[0]);
  });

  it("rejects a subdivision or postal code that does not match the country", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ line1: "12 Broad Street", city: "Lagos", countryCode: "NG" })
      .expect(400);
    await request(app.getHttpServer())
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, subdivisionCode: "US-NY" })
      .expect(400);
    await request(app.getHttpServer())
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, postalCode: "12" })
      .expect(400);
  });

  it("keeps an address inside its tenant when another tenant tries to read or attach it", async () => {
    const created = await request(app.getHttpServer())
      .put(`/api/v1/businesses/${tenantABusinessId}/address`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send(lagos)
      .expect(200);
    const addressId = created.body.data.address.id as string;

    await request(app.getHttpServer())
      .get(`/api/v1/addresses/${addressId}`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .put(`/api/v1/businesses/${tenantABusinessId}/address`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .send({ ...lagos, line1: "Taken" })
      .expect(404);
    const foreignLink = await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${tenantBBusinessId}`)
      .set("authorization", `Bearer ${tenantBToken}`)
      .send({ addressId })
      .expect(200);
    expect(foreignLink.body.data.business.address).toBeNull();

    await expect(
      client.exec(`UPDATE businesses SET address_id = '${addressId}' WHERE id = '${tenantBBusinessId}'`),
    ).rejects.toThrow();

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/businesses/${tenantABusinessId}/address`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, line1: "14 Marina" })
      .expect(200);
    expect(updated.body.data.address.id).toBe(addressId);
    expect(updated.body.data.address.line1).toBe("14 Marina");
  });

  it("lets only a member who can manage the owner change that owner's address", async () => {
    const http = app.getHttpServer();
    const second = await request(http)
      .post("/api/v1/branches")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ name: "Ikeja", businessId: tenantABusinessId })
      .expect(201);
    const otherBranchId = second.body.data.branch.id as string;

    const salesToken = await inviteMember(http, tenantAToken, {
      email: "sales@tenant-a.test",
      role: "SALES",
    });
    const branchAdminToken = await inviteMember(http, tenantAToken, {
      email: "branch-admin@tenant-a.test",
      role: "ADMINISTRATOR",
      businessId: tenantABusinessId,
      branchId: tenantABranchId,
    });

    await request(http)
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${salesToken}`)
      .send(lagos)
      .expect(403);
    await request(http)
      .put(`/api/v1/businesses/${tenantABusinessId}/address`)
      .set("authorization", `Bearer ${salesToken}`)
      .send(lagos)
      .expect(403);
    await request(http)
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${branchAdminToken}`)
      .send(lagos)
      .expect(403);
    await request(http)
      .put(`/api/v1/branches/${otherBranchId}/address`)
      .set("authorization", `Bearer ${branchAdminToken}`)
      .send({ ...lagos, line1: "Other branch" })
      .expect(403);

    const ownBranch = await request(http)
      .put(`/api/v1/branches/${tenantABranchId}/address`)
      .set("authorization", `Bearer ${branchAdminToken}`)
      .send({ ...lagos, line1: "Own branch" })
      .expect(200);
    const branchAddressId = ownBranch.body.data.address.id as string;

    await request(http)
      .get(`/api/v1/addresses/${branchAddressId}`)
      .set("authorization", `Bearer ${salesToken}`)
      .expect(404);
    await request(http).get(`/api/v1/branches/${otherBranchId}`).set("authorization", `Bearer ${branchAdminToken}`).expect(404);
    const visibleBranch = await request(http)
      .get(`/api/v1/branches/${tenantABranchId}`)
      .set("authorization", `Bearer ${branchAdminToken}`)
      .expect(200);
    expect(visibleBranch.body.data.branch.address.line1).toBe("Own branch");

    await request(http)
      .put("/api/v1/organizations/current/address")
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, line1: "Org office" })
      .expect(200);
    await request(http)
      .put(`/api/v1/businesses/${tenantABusinessId}/address`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, line1: "Business office" })
      .expect(200);
    await request(http)
      .put(`/api/v1/branches/${otherBranchId}/address`)
      .set("authorization", `Bearer ${tenantAToken}`)
      .send({ ...lagos, line1: "Ikeja office" })
      .expect(200);
    await request(http).post("/api/v1/addresses").set("authorization", `Bearer ${tenantAToken}`).send(lagos).expect(404);
  });
});

describe("address geography foreign keys", () => {
  it("rejects a country or subdivision that is not in the reference tables", async () => {
    const db = new PGlite();
    try {
      for (const migration of await loadMigrationSql()) {
        await applySqlBatches((statement) => db.exec(statement), migration.sql);
      }
      const tenantId = "11111111-1111-4111-8111-111111111111";
      await expect(
        db.exec(
          `INSERT INTO addresses (id, tenant_id, line1, city, country_code) VALUES ('22222222-2222-4222-8222-222222222222', '${tenantId}', '1 Road', 'Lagos', 'ZZ')`,
        ),
      ).rejects.toThrow();
      await expect(
        db.exec(
          `INSERT INTO addresses (id, tenant_id, line1, city, country_code, subdivision_code) VALUES ('33333333-3333-4333-8333-333333333333', '${tenantId}', '1 Road', 'Lagos', 'NG', 'US-NY')`,
        ),
      ).rejects.toThrow();
      await db.exec(
        `INSERT INTO addresses (id, tenant_id, line1, city, country_code) VALUES ('44444444-4444-4444-8444-444444444444', '${tenantId}', '1 Road', 'Lagos', 'NG')`,
      );
      await db.exec(
        `INSERT INTO addresses (id, tenant_id, line1, city, country_code, subdivision_code) VALUES ('55555555-5555-4555-8555-555555555555', '${tenantId}', '12 Broad Street', 'Lagos', 'NG', 'NG-LA')`,
      );
    } finally {
      await db.close();
    }
  });

  it("aborts the foreign-key migration when an existing address is not in the reference tables", async () => {
    const db = new PGlite();
    try {
      const migrations = await loadMigrationSql();
      const migration = migrations.find((entry) => entry.id.startsWith("0008"));
      expect(migration).toBeTruthy();
      for (const prior of migrations.filter((entry) => entry.id < "0008")) {
        await applySqlBatches((statement) => db.exec(statement), prior.sql);
      }
      await db.exec(
        `INSERT INTO addresses (id, tenant_id, line1, city, country_code) VALUES ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '1 Road', 'Lagos', 'ZZ')`,
      );

      await db.exec("BEGIN");
      await expect(applySqlBatches((statement) => db.exec(statement), migration!.sql)).rejects.toThrow(
        /unknown country or subdivision/,
      );
      await db.exec("ROLLBACK");

      const constraints = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname IN ('addresses_country_fk', 'addresses_subdivision_fk')`,
      );
      expect(constraints.rows).toHaveLength(0);
      const rows = await db.query<{ country_code: string }>(`SELECT country_code FROM addresses`);
      expect(rows.rows.map((row) => row.country_code)).toEqual(["ZZ"]);
    } finally {
      await db.close();
    }
  });
});
