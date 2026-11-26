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
import { auth, expectBalancedBooks, product, shop } from "./test-support.js";

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
  AI_PROVIDER: "fake",
};

describe("ADR-051: the books' profit is always shown", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function profit(token: string, query = "") {
    return (await request(http).get(`/api/v1/money/profit${query}`).set(auth(token)).expect(200)).body.data as {
      today: string;
      salesMinor: string;
      expensesMinor: string;
      costOfSalesMinor: string;
      profitMinor: string;
      profitStatus: string;
      uncostedSalesMinor: string;
      costCoverageBps: number;
      estimatedProfitMinor: string | null;
    };
  }

  it("shows the books' profit for a month where 2% of sales have no cost", async () => {
    const ada = await shop(http, "profit-partial@bizora.test", "Ada Provisions");
    const riceId = await product(http, ada.token, "Rice 50kg", "9800000", "2", "bag");
    await request(http)
      .post("/api/v1/sales")
      .set(auth(ada.token))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "9800000" }] })
      .expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(ada.token))
      .send({ lines: [{ description: "Ogbono", quantity: "1", unit: "cup", unitPriceMinor: "200000", saved: true }], payments: [{ method: "cash", amountMinor: "200000" }] })
      .expect(201);
    const day = await profit(ada.token);
    const month = await profit(ada.token, `?from=${day.today.slice(0, 8)}01&to=${day.today}`);
    for (const view of [day, month]) {
      expect(view).toMatchObject({ salesMinor: "10000000", uncostedSalesMinor: "200000", profitStatus: "partial" });
      expect(view).not.toHaveProperty("knownProfitMinor");
      expect(view.estimatedProfitMinor).toBeNull();
      expect(view.profitMinor).toBe((BigInt(view.salesMinor) - BigInt(view.costOfSalesMinor)).toString());
      expect(BigInt(view.profitMinor)).toBeGreaterThan(BigInt(view.uncostedSalesMinor));
      expect(view.costCoverageBps).toBe(9800);
    }
  });

  async function stocked(token: string, name: string, extra: Record<string, unknown>) {
    const created = await request(http)
      .post("/api/v1/products")
      .set(auth(token))
      .send({ name, baseUnit: "bag", priceMinor: "220000", openingQuantity: "20", ...extra })
      .expect(201);
    return created.body.data.product.id as string;
  }

  async function sell(token: string, productId: string) {
    await request(http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({ lines: [{ productId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "440000" }] })
      .expect(201);
  }

  it("does not count goods added with no cost as free (review, 26 Nov)", async () => {
    const bisi = await shop(http, "profit-nocost@bizora.test", "Bisi Provisions");
    const semovita = await stocked(bisi.token, "Semovita 1kg", {});
    await sell(bisi.token, semovita);
    const view = await profit(bisi.token);
    expect(view).toMatchObject({ salesMinor: "440000", uncostedSalesMinor: "440000", profitStatus: "unknown", costCoverageBps: 0 });
    const lines = await client.query<{ cost_minor: string | null }>("SELECT cost_minor FROM sale_lines WHERE tenant_id = $1", [bisi.tenantId]);
    expect(lines.rows).toEqual([{ cost_minor: null }]);
    await expectBalancedBooks(client, bisi.tenantId);
  });

  it("counts a cost of 0 as known when the owner set it", async () => {
    const ada = await shop(http, "profit-free@bizora.test", "Ada Samples");
    const sample = await stocked(ada.token, "Free sample", { defaultCostMinor: "0" });
    await sell(ada.token, sample);
    expect(await profit(ada.token)).toMatchObject({ uncostedSalesMinor: "0", profitStatus: "known", profitMinor: "440000" });
  });

  it("keeps a real cost on goods added with one", async () => {
    const ada = await shop(http, "profit-costed@bizora.test", "Ada Costed");
    const rice = await stocked(ada.token, "Rice 1kg", { openingCostMinor: "3000000" });
    await sell(ada.token, rice);
    expect(await profit(ada.token)).toMatchObject({ uncostedSalesMinor: "0", profitStatus: "known", costOfSalesMinor: "300000", profitMinor: "140000" });
  });

  it("shows sales minus expenses for a food shop that records ingredients as expenses", async () => {
    const mama = await shop(http, "profit-buka@bizora.test", "Mama Buka");
    await request(http)
      .post("/api/v1/sales")
      .set(auth(mama.token))
      .send({ lines: [{ description: "Jollof", quantity: "4", unit: "plate", unitPriceMinor: "500000", saved: true }], payments: [{ method: "cash", amountMinor: "2000000" }] })
      .expect(201);
    const categories = (await request(http).get("/api/v1/money/categories").set(auth(mama.token)).expect(200)).body.data.categories as { id: string; name: string }[];
    const other = categories.find((category) => category.name === "Other expenses");
    await request(http)
      .post("/api/v1/money/expenses")
      .set(auth(mama.token))
      .send({ categoryId: other?.id, amountMinor: "800000", paidFrom: "owner", payee: "Foodstuff from the market" })
      .expect(201);
    const view = await profit(mama.token);
    expect(view).toMatchObject({
      salesMinor: "2000000",
      expensesMinor: "800000",
      costOfSalesMinor: "0",
      profitMinor: "1200000",
      profitStatus: "unknown",
      uncostedSalesMinor: "2000000",
      estimatedProfitMinor: null,
    });
    expect(view).not.toHaveProperty("knownProfitMinor");
  });

  it("keeps the books' profit and adds the estimate as its own figure", async () => {
    const ada = await shop(http, "profit-estimate@bizora.test", "Ada Soup");
    await request(http)
      .post("/api/v1/sales")
      .set(auth(ada.token))
      .send({ lines: [{ description: "Pepper soup", quantity: "1", unit: "bowl", unitPriceMinor: "1000000", saved: true }], payments: [{ method: "cash", amountMinor: "1000000" }] })
      .expect(201);
    const before = await profit(ada.token);
    expect(before).toMatchObject({ profitMinor: "1000000", profitStatus: "unknown", estimatedProfitMinor: null });
    const items = (await request(http).get("/api/v1/saved-items").set(auth(ada.token)).expect(200)).body.data.items as { id: string; name: string }[];
    const soup = items.find((item) => item.name === "Pepper soup");
    await request(http)
      .post(`/api/v1/saved-items/${soup?.id}/cost-estimate`)
      .set(auth(ada.token))
      .send({ estimatedCostMinor: "400000", periodStart: "2020-01-01", periodEnd: "2099-12-31", reason: "About 4,000 naira a bowl" })
      .expect(200);
    const after = await profit(ada.token);
    expect(after.profitMinor).toBe("1000000");
    expect(after.estimatedProfitMinor).toBe("600000");
    expect(after).not.toHaveProperty("knownProfitMinor");
  });
});
