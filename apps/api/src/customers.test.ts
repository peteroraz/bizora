import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { auditEvents, businesses, schema } from "./db/schema.js";
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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  // These tests create several shops and invite several people; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
};

const password = "LocalOnly!Passw0rd";

describe("customers and follow-ups", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerToken = "";
  let otherToken = "";
  let salesToken = "";
  let inventoryToken = "";
  let auditorToken = "";
  let businessId = "";
  let mainBranchId = "";
  let secondBranchId = "";
  let customerId = "";

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
        email: "owner@customers.test",
        password,
        displayName: "Ada Owner",
        organizationName: "Ada Stores",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
      })
      .expect(201);
    ownerToken = owner.body.data.accessToken as string;
    businessId = owner.body.data.tenant.businessId as string;
    mainBranchId = owner.body.data.tenant.branchId as string;

    await request(http)
      .patch("/api/v1/onboarding")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        countryCode: "NG",
        industryCode: "general-retail",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        businessName: "Ada Stores",
        branchName: "Main",
      })
      .expect(200);

    const createdBranch = await request(http)
      .post("/api/v1/branches")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "Onitsha", businessId })
      .expect(201);
    secondBranchId = createdBranch.body.data.branch.id as string;

    salesToken = await invite(http, ownerToken, "sales@customers.test", "SALES", secondBranchId, businessId);
    inventoryToken = await invite(http, ownerToken, "stock@customers.test", "INVENTORY", mainBranchId, businessId);
    auditorToken = await invite(http, ownerToken, "audit@customers.test", "AUDITOR", mainBranchId, businessId);

    const other = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "other@customers.test",
        password,
        displayName: "Other Owner",
        organizationName: "Other Stores",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
      })
      .expect(201);
    otherToken = other.body.data.accessToken as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set("authorization", `Bearer ${otherToken}`)
      .send({
        countryCode: "NG",
        businessType: "services",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        staffCountBand: "1",
        otherCurrencies: false,
        branchCount: 1,
        marketOrPlaza: "Main Market",
        tradeCity: "Onitsha",
        tradeSubdivisionCode: "NG-AN",
      })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("keeps the currency and industry already saved, and configures a new shop from the answers", async () => {
    const saved = await request(app.getHttpServer())
      .get("/api/v1/businesses")
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const business = saved.body.data.items[0];
    expect(String(business.baseCurrencyCode).trim()).toBe("NGN");
    expect(business.industryCode).toBe("general-retail");
    expect(business.name).toBe("Ada Stores");
    expect(business.staffFeaturesEnabled).toBe(true);
    expect(business.visibleModules).toContain("customers");

    const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    expect(row?.baseCurrencyCode.trim()).toBe("NGN");
    await client.exec(`
      UPDATE businesses
      SET business_type = NULL, industry_code = 'wholesale'
      WHERE id = '${businessId}';
      UPDATE businesses
      SET business_type = CASE industry_code
        WHEN 'wholesale' THEN 'wholesale'
        WHEN 'hospitality' THEN 'food'
        WHEN 'professional-services' THEN 'services'
        WHEN 'healthcare-clinic' THEN 'services'
        ELSE 'shop'
      END
      WHERE business_type IS NULL AND industry_code IS NOT NULL;
    `);
    const [backfilled] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    expect(backfilled?.businessType).toBe("wholesale");
    expect(backfilled?.baseCurrencyCode.trim()).toBe("NGN");
    await db
      .update(businesses)
      .set({ industryCode: "general-retail", businessType: "shop" })
      .where(eq(businesses.id, businessId));

    const configured = await request(app.getHttpServer())
      .get("/api/v1/businesses")
      .set("authorization", `Bearer ${otherToken}`)
      .expect(200);
    const otherBusiness = configured.body.data.items[0];
    expect(otherBusiness.businessType).toBe("services");
    expect(otherBusiness.staffFeaturesEnabled).toBe(false);
    expect(otherBusiness.multiCurrencyEnabled).toBe(false);
    expect(otherBusiness.visibleModules).not.toContain("staff");
    expect(otherBusiness.visibleModules).not.toContain("stock");
    expect(otherBusiness.visibleModules).toContain("customers");
    const profile = configured.body.data.items[0];
    expect(profile.address.marketOrPlaza).toBe("Main Market");
    expect(profile.address.city).toBe("Onitsha");
  });

  it("normalises a Nigerian local phone and warns on a duplicate", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Chinedu Obi",
        phone: "08031234567",
        email: "chinedu@example.com",
        branchId: mainBranchId,
        tags: ["cement"],
        address: {
          shopNumber: "B12",
          lineOrBlock: "4",
          marketOrPlaza: "Main Market",
          city: "Onitsha",
          countryCode: "NG",
          subdivisionCode: "NG-AN",
        },
      })
      .expect(201);
    customerId = created.body.data.customer.id as string;
    expect(created.body.data.customer.phoneE164).toBe("+2348031234567");
    expect(created.body.data.customer.addressFormatted).toBe("Shop B12, Line 4, Main Market, Onitsha, Anambra");

    const duplicate = await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "Someone else", phone: "0803 123 4567", branchId: mainBranchId })
      .expect(409);
    expect(duplicate.body.error.code).toBe("DUPLICATE_PHONE");
    expect(duplicate.body.error.message).toMatch(/already/i);
    expect(duplicate.body.error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "customerId", message: customerId })]),
    );

    const walkIn = await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "Walk-in", isWalkIn: true, branchId: secondBranchId })
      .expect(201);
    expect(walkIn.body.data.customer.phoneE164).toBeNull();
    expect(walkIn.body.data.customer.branchId).toBe(secondBranchId);
  });

  it("hides another tenant's customers, notes, follow-ups, and import rows", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${otherToken}`)
      .send({ name: "Hijacked", phone: "08039876543" })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/customers/${customerId}/notes`)
      .set("authorization", `Bearer ${otherToken}`)
      .send({ body: "no" })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/customers/${customerId}/followups`)
      .set("authorization", `Bearer ${otherToken}`)
      .send({ reason: "no", dueOn: "2026-11-15" })
      .expect(404);

    const imported = await request(app.getHttpServer())
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${otherToken}`)
      .send({
        commit: true,
        csv: "name,phone,email,notes\nHijacked,08031234567,x@example.com,stolen\n",
      })
      .expect(201);
    expect(imported.body.data.created).toBe(1);

    const original = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(original.body.data.customer.name).toBe("Chinedu Obi");
    expect(original.body.data.customer.phoneE164).toBe("+2348031234567");
  });

  it("limits sales staff to their shop and denies roles without permission", async () => {
    const onSecond = await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "Onitsha Buyer", phone: "08032345678", branchId: secondBranchId })
      .expect(201);
    const secondId = onSecond.body.data.customer.id as string;

    const salesList = await request(app.getHttpServer())
      .get("/api/v1/customers")
      .set("authorization", `Bearer ${salesToken}`)
      .expect(200);
    const names = salesList.body.data.items.map((item: { name: string }) => item.name);
    expect(names).toContain("Walk-in");
    expect(names).toContain("Onitsha Buyer");
    expect(names).not.toContain("Chinedu Obi");
    expect(salesList.body.data.pageSize).toBe(25);

    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${salesToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${salesToken}`)
      .send({ name: "Nope", phone: "08031234567" })
      .expect(404);

    const forced = await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${salesToken}`)
      .send({ name: "Forced shop", phone: "08033456789", branchId: mainBranchId })
      .expect(201);
    expect(forced.body.data.customer.branchId).toBe(secondBranchId);

    await request(app.getHttpServer())
      .get("/api/v1/customers")
      .set("authorization", `Bearer ${inventoryToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${auditorToken}`)
      .send({ name: "No", phone: "08035555555" })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set("authorization", `Bearer ${auditorToken}`)
      .expect(200);

    expect(secondId).toBeTruthy();
  });

  it("records a note and a follow-up that is due today, and imports three rows", async () => {
    const noted = await request(app.getHttpServer())
      .post(`/api/v1/customers/${customerId}/notes`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ body: "Asked about cement." })
      .expect(201);
    expect(noted.body.data.items[0].body).toBe("Asked about cement.");

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await request(app.getHttpServer())
      .post(`/api/v1/customers/${customerId}/followups`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Call about the balance", dueOn: today })
      .expect(201);

    const home = await request(app.getHttpServer())
      .get("/api/v1/dashboard")
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(home.body.data.customerCount).toBeGreaterThan(0);
    expect(home.body.data.followupsDueToday.map((item: { reason: string }) => item.reason)).toContain(
      "Call about the balance",
    );
    expect(home.body.data.checklist.find((item: { id: string }) => item.id === "first-customer").done).toBe(true);

    const preview = await request(app.getHttpServer())
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        commit: false,
        csv: "name,phone,email,notes\nAda,08035551111,ada@example.com,Pays Friday\nBad,12,not-an-email,Broken\nChinedu Obi,08031234567,chinedu@example.com,Updated note\n",
      })
      .expect(201);
    expect(preview.body.data.committed).toBe(false);
    expect(preview.body.data.rows.find((row: { line: number }) => row.line === 3).action).toBe("error");
    expect(preview.body.data.created).toBe(0);

    const committed = await request(app.getHttpServer())
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        commit: true,
        csv: [
          "name,phone,email,notes",
          "Ada,08035551111,ada@example.com,Pays Friday",
          "Bola,08036662222,bola@example.com,Rice",
          "Tunde,08037773333,,Saturday",
          "Bad,12,not-an-email,Broken",
        ].join("\n"),
      })
      .expect(201);
    expect(committed.body.data.created).toBe(3);
    expect(committed.body.data.errors).toBe(1);

    const again = await request(app.getHttpServer())
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        commit: true,
        csv: "name,phone,email,notes\nAda Updated,08035551111,ada@example.com,Pays Friday\n",
      })
      .expect(201);
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.updated).toBe(1);

    const found = await request(app.getHttpServer())
      .get("/api/v1/customers")
      .query({ q: "08035551111", page: "1" })
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(found.body.data.items).toEqual([
      expect.objectContaining({ name: "Ada Updated", phoneE164: "+2348035551111" }),
    ]);

    const actions = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "customer"), eq(auditEvents.action, "customer.imported")));
    expect(actions.length).toBeGreaterThan(0);
    const created = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "customer.created"));
    expect(created.length).toBeGreaterThan(0);
    const followup = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "followup.created"));
    expect(followup.length).toBe(1);
  });
});

async function invite(
  http: Parameters<typeof request>[0],
  ownerToken: string,
  email: string,
  role: string,
  branchId: string,
  businessId: string,
) {
  const invited = await request(http)
    .post("/api/v1/invitations")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ email, role, businessId, branchId })
    .expect(201);
  await request(http)
    .post("/api/v1/invitations/accept")
    .send({ token: invited.body.data.invitation.token, displayName: email, password })
    .expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}
