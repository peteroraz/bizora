import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { booksCouldNotSave } from "./common/errors.js";
import { ChartOfAccountsService } from "./modules/ledger/chart-of-accounts.service.js";
import { LedgerPostingService, type PostingRequest } from "./modules/ledger/ledger-posting.service.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { uuidv7 } from "@bizora/contracts";

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
  DEFAULT_PLAN_CODE: "business",
};

const password = "LocalOnly!Passw0rd";
type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string, industryCode: string) {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@books.test`,
      password,
      displayName: `Owner ${label}`,
      organizationName: `Shop ${label}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode,
    })
    .expect(201);
  const token = owner.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({
      countryCode: "NG",
      industryCode,
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      businessName: `Shop ${label}`,
      branchName: "Main",
    })
    .expect(200);
  const me = await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`).expect(200);
  return {
    token,
    tenantId: me.body.data.tenant.tenantId as string,
    businessId: me.body.data.tenant.businessId as string,
    branchId: me.body.data.tenant.branchId as string,
  };
}

describe("books after a business changes type", () => {
  let app: INestApplication;
  let client: PGlite;
  let chart: ChartOfAccountsService;
  let ledger: LedgerPostingService;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    chart = app.get(ChartOfAccountsService);
    ledger = app.get(LedgerPostingService);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function rows(businessId: string) {
    const result = await client.query<{ code: string; name: string; role: string }>(
      "SELECT code, name, role FROM ledger_accounts WHERE business_id = $1 ORDER BY code",
      [businessId],
    );
    return result.rows;
  }

  it("adds service income when a shop becomes a service business, and keeps the old sales account", async () => {
    const http = app.getHttpServer();
    const shop = await registerOwner(http, "mechanic", "general-retail");
    await chart.list(shop.tenantId, shop.businessId);
    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(shop.token))
      .send({ name: "Bolt", baseUnit: "piece", priceMinor: "100000", openingQuantity: "5", openingCostMinor: "250000" })
      .expect(201);
    const sold = await request(http)
      .post("/api/v1/sales")
      .set(auth(shop.token))
      .send({ lines: [{ productId: product.body.data.product.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "100000" }] })
      .expect(201);
    expect(sold.body.data.sale.totalMinor).toBe("100000");
    const before = await rows(shop.businessId);
    const sales = before.find((account) => account.code === "4000");
    expect(sales).toMatchObject({ name: "Sales", role: "sales" });
    await client.query("DELETE FROM ledger_accounts WHERE business_id = $1 AND code = '4050'", [shop.businessId]);

    const changed = await request(http).patch(`/api/v1/businesses/${shop.businessId}`).set(auth(shop.token)).send({ businessType: "services" }).expect(200);
    expect(changed.body.data.business.businessType).toBe("services");

    const after = await rows(shop.businessId);
    expect(after.find((account) => account.code === "4000")).toEqual(sales);
    expect(after.find((account) => account.role === "service_income")).toMatchObject({ code: "4050", name: "Service income" });
    const roles = after.filter((account) => account.role !== "cash" && account.role !== "expense").map((account) => account.role);
    expect(new Set(roles).size).toBe(roles.length);

    const opened = await request(http)
      .post("/api/v1/jobs")
      .set(auth(shop.token))
      .send({ customer: { name: "Ada", phone: "08031112233" }, title: "Oil service", lines: [{ kind: "work", description: "Labour", unitPriceMinor: "250000" }] })
      .expect(201);
    await request(http).post(`/api/v1/jobs/${opened.body.data.job.id}/finish`).set(auth(shop.token)).send({ dueDate: "2099-01-31" }).expect(200);
    const again = await request(http)
      .post("/api/v1/sales")
      .set(auth(shop.token))
      .send({ lines: [{ description: "Diagnosis", quantity: "1", unit: "piece", unitPriceMinor: "500000" }], payments: [{ method: "cash", amountMinor: "500000" }] })
      .expect(201);
    expect(again.body.data.sale.status).toBe("completed");

    const trial = await ledger.trialBalance(shop.tenantId, shop.businessId);
    expect(trial.balanced).toBe(true);
    expect(trial.accounts.find((account) => account.code === "4000")?.balanceMinor).toBe(-100000n);
    expect(trial.accounts.find((account) => account.code === "4050")?.balanceMinor).toBe(-750000n);
    const work = await client.query<{ memo: string }>(
      "SELECT memo FROM journal_lines WHERE account_id = (SELECT id FROM ledger_accounts WHERE business_id = $1 AND code = '4050') AND memo = 'Work done'",
      [shop.businessId],
    );
    expect(work.rows).toHaveLength(1);
    const count = Number((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_accounts WHERE business_id = $1", [shop.businessId])).rows[0]?.n);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(shop.token))
      .send({ lines: [{ description: "Wash", quantity: "1", unit: "piece", unitPriceMinor: "200000" }], payments: [{ method: "cash", amountMinor: "200000" }] })
      .expect(201);
    const afterSecond = Number((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_accounts WHERE business_id = $1", [shop.businessId])).rows[0]?.n);
    expect(afterSecond).toBe(count);
  });

  it("adds 4050 on the first sale when an old services chart has no service income, and nothing on the second", async () => {
    const http = app.getHttpServer();
    const shop = await registerOwner(http, "oldchart", "general-retail");
    await chart.list(shop.tenantId, shop.businessId);
    await client.query("DELETE FROM ledger_accounts WHERE business_id = $1 AND code = '4050'", [shop.businessId]);
    await client.query("UPDATE businesses SET industry_code = 'professional-services', business_type = 'services' WHERE id = $1", [shop.businessId]);
    const before = await rows(shop.businessId);
    expect(before.some((account) => account.role === "service_income")).toBe(false);

    const first = await request(http)
      .post("/api/v1/sales")
      .set(auth(shop.token))
      .send({ lines: [{ description: "Repair", quantity: "1", unit: "piece", unitPriceMinor: "400000" }], payments: [{ method: "cash", amountMinor: "400000" }] })
      .expect(201);
    expect(first.body.data.sale.totalMinor).toBe("400000");
    expect(await rows(shop.businessId)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "4050", name: "Service income", role: "service_income" })]));
    const count = (await rows(shop.businessId)).length;
    await request(http)
      .post("/api/v1/sales")
      .set(auth(shop.token))
      .send({ lines: [{ description: "Check", quantity: "1", unit: "piece", unitPriceMinor: "100000" }], payments: [{ method: "cash", amountMinor: "100000" }] })
      .expect(201);
    expect((await rows(shop.businessId)).length).toBe(count);
    const trial = await ledger.trialBalance(shop.tenantId, shop.businessId);
    expect(trial.balanced).toBe(true);
    expect(trial.accounts.find((account) => account.code === "4050")?.balanceMinor).toBe(-500000n);
  });

  it("posts a former service business's sales to sales and the cost to cost of goods", async () => {
    const http = app.getHttpServer();
    const services = await registerOwner(http, "workshop", "professional-services");
    const chartBefore = await chart.list(services.tenantId, services.businessId);
    expect(chartBefore.find((account) => account.code === "4000")).toMatchObject({ name: "Service income", role: "service_income" });
    expect(chartBefore.some((account) => account.role === "sales")).toBe(false);
    const kept = chartBefore.map((account) => ({ code: account.code, name: account.name, role: account.role }));

    await request(http).patch(`/api/v1/businesses/${services.businessId}`).set(auth(services.token)).send({ businessType: "shop" }).expect(200);
    const chartAfter = await rows(services.businessId);
    for (const account of kept) expect(chartAfter).toEqual(expect.arrayContaining([account]));
    const sales = chartAfter.find((account) => account.role === "sales");
    expect(sales?.name).toBe("Sales");
    expect(sales?.code).not.toBe("4000");

    const product = await request(http)
      .post("/api/v1/products")
      .set(auth(services.token))
      .send({ name: "Spark plug", baseUnit: "piece", priceMinor: "200000", openingQuantity: "2", openingCostMinor: "200000" })
      .expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(services.token))
      .send({ lines: [{ productId: product.body.data.product.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "200000" }] })
      .expect(201);
    const trial = await ledger.trialBalance(services.tenantId, services.businessId);
    expect(trial.balanced).toBe(true);
    expect(trial.accounts.find((account) => account.code === sales?.code)?.balanceMinor).toBe(-200000n);
    expect(trial.accounts.find((account) => account.code === "5000")?.balanceMinor).toBeGreaterThan(0n);
    const roles = (await rows(services.businessId)).filter((account) => account.role !== "cash" && account.role !== "expense").map((account) => account.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("tells the trader to contact support, and keeps the account detail in the log message only", async () => {
    const shop = await registerOwner(app.getHttpServer(), "wording", "general-retail");
    const requestBody: PostingRequest = {
      businessId: shop.businessId,
      branchId: shop.branchId,
      entryDate: "2026-11-24",
      source: { type: "sale", id: uuidv7() },
      postingKey: "missing-account",
      description: "Missing account",
      lines: [
        { account: { code: "9999" }, debitMinor: 100n },
        { account: { role: "cash" }, creditMinor: 100n },
      ],
    };
    const db = drizzle(client, { schema });
    const error = await db
      .transaction((tx) => ledger.post(tx, { tenantId: shop.tenantId, userId: null, correlationId: "abcdef12-9999-4000-8000-000000000000" }, requestBody))
      .catch((caught: { code?: string; message?: string }) => caught);
    expect(error.code).toBe("LEDGER_ACCOUNT_NOT_FOUND");
    expect(error.message).toBe(booksCouldNotSave("abcdef12-9999-4000-8000-000000000000"));
    expect(error.message).not.toContain("{");
    expect(error.message).not.toContain("9999");
  });
});
