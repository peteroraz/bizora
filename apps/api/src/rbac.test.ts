import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
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
};

async function registerOwner(http: unknown, email: string, org: string) {
  const response = await request(http as never)
    .post("/api/v1/auth/register")
    .send({
      email,
      password: "LocalOnly!Passw0rd",
      displayName: "Owner",
      organizationName: org,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode: "general-retail",
    });
  if (response.status !== 201) {
    throw new Error(`register failed ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as {
    accessToken: string;
    tenant: { tenantId: string; businessId: string; branchId: string };
  };
}

describe("rbac and branch scoping", () => {
  let app: INestApplication;
  let client: PGlite;
  let ownerToken = "";
  let salesToken = "";
  let mainBranchId = "";
  let secondBranchId = "";

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();

    const owner = await registerOwner(http, "owner@tenant-a.test", "Tenant A Foods");
    ownerToken = owner.accessToken;
    mainBranchId = owner.tenant.branchId;

    await request(http)
      .patch("/api/v1/onboarding")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        countryCode: "NG",
        industryCode: "general-retail",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        branchName: "Main",
        primaryColor: "#1D4ED8",
      })
      .expect(200);

    const created = await request(http)
      .post("/api/v1/branches")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "Ikeja", businessId: owner.tenant.businessId })
      .expect(201);
    secondBranchId = created.body.data.branch.id as string;

    const invited = await request(http)
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        email: "sales@tenant-a.test",
        role: "SALES",
        businessId: owner.tenant.businessId,
        branchId: secondBranchId,
      })
      .expect(201);

    await request(http)
      .post("/api/v1/invitations/accept")
      .send({
        token: invited.body.data.invitation.token,
        displayName: "Sales Person",
        password: "LocalOnly!Passw0rd",
      })
      .expect(201);

    const login = await request(http)
      .post("/api/v1/auth/login")
      .send({ email: "sales@tenant-a.test", password: "LocalOnly!Passw0rd" })
      .expect(201);
    salesToken = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets the owner complete onboarding and read memberships", async () => {
    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(me.body.data.onboardingCompleted).toBe(true);
    expect(me.body.data.tenant.permissions).toContain("users.invite");

    const people = await request(app.getHttpServer())
      .get("/api/v1/memberships")
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(people.body.data.items.length).toBe(2);
  });

  it("blocks a sales user from branding and invitations", async () => {
    await request(app.getHttpServer())
      .patch("/api/v1/organizations/current/branding")
      .set("authorization", `Bearer ${salesToken}`)
      .send({ primaryColor: "#FF0000" })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${salesToken}`)
      .send({ email: "other@tenant-a.test", role: "EMPLOYEE" })
      .expect(403);

    await request(app.getHttpServer())
      .get("/api/v1/memberships")
      .set("authorization", `Bearer ${salesToken}`)
      .expect(403);
  });

  it("hides another branch in the same tenant from a branch-scoped sales user", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/branches/${mainBranchId}`)
      .set("authorization", `Bearer ${salesToken}`)
      .expect(404);

    const visible = await request(app.getHttpServer())
      .get(`/api/v1/branches/${secondBranchId}`)
      .set("authorization", `Bearer ${salesToken}`)
      .expect(200);
    expect(visible.body.data.branch.id).toBe(secondBranchId);

    const list = await request(app.getHttpServer())
      .get("/api/v1/branches")
      .set("authorization", `Bearer ${salesToken}`)
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].id).toBe(secondBranchId);
  });
});
