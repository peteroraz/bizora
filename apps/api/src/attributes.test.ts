import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@bizora/contracts";
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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  // Several staff are invited; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";


describe("ADR-060: product attributes and making variants", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let colour: { id: string; options: { id: string; value: string }[] };
  let size: { id: string; options: { id: string; value: string }[] };
  let storage = "";
  let itemId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const option = (attribute: { options: { id: string; value: string }[] }, value: string) => attribute.options.find((item) => item.value === value)!.id;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@attr.test", password, displayName: "Ifeoma Owner", organizationName: "Ifeoma Fashion", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ifeoma Fashion", branchName: "Main" }).expect(200);
    cashier = await invite(http, owner, "cashier@attr.test", "CASHIER", branchId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@attr.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
    const item = await request(http).post("/api/v1/catalog/items").set(auth(owner)).send({ name: "Polo shirt", variants: [{ baseUnit: "piece", priceMinor: "800000" }] }).expect(201);
    itemId = item.body.data.item.id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets the business define its own attributes, with choices, and keeps staff from changing them", async () => {
    await request(http).post("/api/v1/catalog/attributes").set(auth(cashier)).send({ name: "Colour", options: ["Red"] }).expect(403);
    colour = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Colour", options: ["Red", "Black", "red "] }).expect(201)).body.data.attribute;
    expect(colour.options.map((item) => item.value)).toEqual(["Red", "Black"]);
    size = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Size", options: ["S", "M"] }).expect(201)).body.data.attribute;
    size = (await request(http).patch(`/api/v1/catalog/attributes/${size.id}`).set(auth(owner)).send({ addOptions: ["L", "M"] }).expect(200)).body.data.attribute;
    expect(size.options.map((item) => item.value)).toEqual(["S", "M", "L"]);
    storage = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Storage", kind: "number", unit: "GB" }).expect(201)).body.data.attribute.id;
    expect((await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: " colour" }).expect(409)).body.error.code).toBe("DUPLICATE_NAME");
    await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Material", kind: "text", options: ["Cotton"] }).expect(400);
    // Staff can see them, to sell.
    expect((await request(http).get("/api/v1/catalog/attributes").set(auth(cashier)).expect(200)).body.data.items).toHaveLength(3);
  });

  it("makes one variant per combination, names them, and skips what already exists", async () => {
    const preview = await request(http)
      .post(`/api/v1/catalog/items/${itemId}/generate-variants`)
      .set(auth(owner))
      .send({ dryRun: true, attributes: [{ attributeId: colour.id, optionIds: [option(colour, "Red"), option(colour, "Black")] }, { attributeId: size.id, optionIds: [option(size, "S"), option(size, "M"), option(size, "L")] }] })
      .expect(200);
    expect(preview.body.data.wouldMake).toEqual(["Polo shirt Red / S", "Polo shirt Red / M", "Polo shirt Red / L", "Polo shirt Black / S", "Polo shirt Black / M", "Polo shirt Black / L"]);
    expect(preview.body.data.made).toEqual([]);

    const made = await request(http)
      .post(`/api/v1/catalog/items/${itemId}/generate-variants`)
      .set(auth(owner))
      .send({ priceMinor: "850000", attributes: [{ attributeId: colour.id, optionIds: [option(colour, "Red"), option(colour, "Black")] }, { attributeId: size.id, optionIds: [option(size, "S"), option(size, "M")] }] })
      .expect(200);
    expect(made.body.data.made).toHaveLength(4);
    // Again, with one size more: only the two new ones are made.
    const again = await request(http)
      .post(`/api/v1/catalog/items/${itemId}/generate-variants`)
      .set(auth(owner))
      .send({ attributes: [{ attributeId: colour.id, optionIds: [option(colour, "Red"), option(colour, "Black")] }, { attributeId: size.id, optionIds: [option(size, "S"), option(size, "M"), option(size, "L")] }] })
      .expect(200);
    expect(again.body.data.made.map((entry: { name: string }) => entry.name)).toEqual(["Polo shirt Red / L", "Polo shirt Black / L"]);
    expect(again.body.data.skipped).toHaveLength(4);

    const item = (await request(http).get(`/api/v1/catalog/items/${itemId}`).set(auth(owner)).expect(200)).body.data.item;
    const redM = item.variants.find((variant: { name: string }) => variant.name === "Polo shirt Red / M");
    expect(redM).toMatchObject({ priceMinor: "850000", trackStock: true });
    expect(redM.attributes.map((entry: { name: string; value: string }) => [entry.name, entry.value])).toEqual([
      ["Colour", "Red"],
      ["Size", "M"],
    ]);
    // A variant made this way sells like any other product.
    await request(http).post("/api/v1/stock/receive").set(auth(owner)).send({ id: uuidv7(), productId: redM.id, quantity: "5", unit: "piece", totalCostMinor: "2500000", paidFrom: "cash" }).expect(201);
    await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ productId: redM.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "850000" }] }).expect(201);
  });

  it("refuses too many combinations, choices of another attribute, and a list with several choices allowed", async () => {
    const many = Array.from({ length: 11 }, (_, index) => `C${index}`);
    const wide = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Shade", options: many }).expect(201)).body.data.attribute;
    const long = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Length", options: many }).expect(201)).body.data.attribute;
    const tooMany = await request(http)
      .post(`/api/v1/catalog/items/${itemId}/generate-variants`)
      .set(auth(owner))
      .send({ attributes: [{ attributeId: wide.id, optionIds: wide.options.map((item: { id: string }) => item.id) }, { attributeId: long.id, optionIds: long.options.map((item: { id: string }) => item.id) }] })
      .expect(400);
    expect(tooMany.body.error.code).toBe("TOO_MANY_VARIANTS");
    await request(http)
      .post(`/api/v1/catalog/items/${itemId}/generate-variants`)
      .set(auth(owner))
      .send({ attributes: [{ attributeId: colour.id, optionIds: [option(size, "S")] }] })
      .expect(400);
    const tags = (await request(http).post("/api/v1/catalog/attributes").set(auth(owner)).send({ name: "Occasion", kind: "multi_select", options: ["Work", "Party"] }).expect(201)).body.data.attribute;
    await request(http).post(`/api/v1/catalog/items/${itemId}/generate-variants`).set(auth(owner)).send({ attributes: [{ attributeId: tags.id, optionIds: [tags.options[0].id] }] }).expect(400);
  });

  it("sets a variant's values of every kind, one at a time, and checks them", async () => {
    const phone = await request(http).post("/api/v1/catalog/items").set(auth(owner)).send({ name: "Tecno Spark 30", variants: [{ baseUnit: "piece", priceMinor: "18500000" }] }).expect(201);
    const productId = phone.body.data.item.variants[0].id as string;
    const tags = (await request(http).get("/api/v1/catalog/attributes").set(auth(owner)).expect(200)).body.data.items.find((item: { name: string }) => item.name === "Occasion");
    const set = await request(http)
      .put(`/api/v1/catalog/products/${productId}/attributes`)
      .set(auth(owner))
      .send({ values: [{ attributeId: storage, number: "128" }, { attributeId: colour.id, optionIds: [option(colour, "Black")] }, { attributeId: tags.id, optionIds: tags.options.map((item: { id: string }) => item.id) }] })
      .expect(200);
    expect(set.body.data.attributes.map((entry: { name: string; value: string }) => [entry.name, entry.value])).toEqual([
      ["Colour", "Black"],
      ["Occasion", "Work, Party"],
      ["Storage", "128 GB"],
    ]);
    await request(http).put(`/api/v1/catalog/products/${productId}/attributes`).set(auth(owner)).send({ values: [{ attributeId: colour.id, optionIds: [option(colour, "Red"), option(colour, "Black")] }] }).expect(400);
    await request(http).put(`/api/v1/catalog/products/${productId}/attributes`).set(auth(owner)).send({ values: [{ attributeId: storage, number: "lots" }] }).expect(400);
    await request(http).put(`/api/v1/catalog/products/${productId}/attributes`).set(auth(cashier)).send({ values: [] }).expect(403);
    // Clearing one leaves the others.
    const cleared = await request(http).put(`/api/v1/catalog/products/${productId}/attributes`).set(auth(owner)).send({ values: [{ attributeId: tags.id }] }).expect(200);
    expect(cleared.body.data.attributes.map((entry: { name: string }) => entry.name)).toEqual(["Colour", "Storage"]);
  });

  it("keeps attributes inside their own business", async () => {
    await request(http).get(`/api/v1/catalog/items/${itemId}`).set(auth(other)).expect(404);
    await request(http).patch(`/api/v1/catalog/attributes/${colour.id}`).set(auth(other)).send({ name: "Mine" }).expect(404);
    expect((await request(http).get("/api/v1/catalog/attributes").set(auth(other)).expect(200)).body.data.items).toEqual([]);
    const theirs = await request(http).post("/api/v1/catalog/items").set(auth(other)).send({ name: "Shirt", variants: [{ baseUnit: "piece", priceMinor: "100" }] }).expect(201);
    await request(http)
      .post(`/api/v1/catalog/items/${theirs.body.data.item.id}/generate-variants`)
      .set(auth(other))
      .send({ attributes: [{ attributeId: colour.id, optionIds: [option(colour, "Red")] }] })
      .expect(404);
    await request(http)
      .put(`/api/v1/catalog/products/${theirs.body.data.item.variants[0].id}/attributes`)
      .set(auth(other))
      .send({ values: [{ attributeId: colour.id, optionIds: [option(colour, "Red")] }] })
      .expect(404);
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
