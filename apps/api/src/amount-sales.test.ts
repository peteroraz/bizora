import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import { uuidv7 } from "@bizora/contracts";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { auth, product, shop } from "./test-support.js";

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

describe("ADR-069: a sale recorded as just an amount", () => {
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

  const amountSale = (amountMinor: string, method: "cash" | "transfer" | "pos", description?: string) => ({
    lines: [{ amountMinor, ...(description ? { description } : {}) }],
    payments: [{ method, amountMinor }],
  });

  it("records amounts with no item, totals them by payment method, and never claims a profit", async () => {
    const mama = await shop(http, "amount-day@bizora.test", "Mama Bisi Kiosk");
    const business = (await request(http).get(`/api/v1/businesses/${mama.businessId}`).set(auth(mama.token)).expect(200)).body.data.business;
    // A new shop starts with amounts allowed.
    expect(business.amountSales).toBe(true);

    const first = await request(http).post("/api/v1/sales").set(auth(mama.token)).send(amountSale("350000", "cash")).expect(201);
    await request(http).post("/api/v1/sales").set(auth(mama.token)).send(amountSale("820000", "transfer", "Bread and drinks")).expect(201);
    await request(http).post("/api/v1/sales").set(auth(mama.token)).send(amountSale("180000", "cash")).expect(201);
    await request(http).post("/api/v1/sales").set(auth(mama.token)).send(amountSale("1400000", "pos")).expect(201);

    const sale = (await request(http).get(`/api/v1/sales/${first.body.data.sale.id}`).set(auth(mama.token)).expect(200)).body.data.sale;
    expect(sale.totalMinor).toBe("350000");
    expect(sale.lines).toHaveLength(1);
    expect(sale.lines[0]).toMatchObject({ description: "Sale", lineKind: "amount", productId: null });

    const day = (await request(http).get("/api/v1/sales/summary").set(auth(mama.token)).expect(200)).body.data;
    expect(day.count).toBe(4);
    expect(day.totalMinor).toBe("2750000");
    expect(day.byMethod).toMatchObject({ cash: "530000", transfer: "820000", pos: "1400000" });

    // Counted as sales; cost unknown, so no profit is claimed for it.
    const profit = (await request(http).get("/api/v1/money/profit").set(auth(mama.token)).expect(200)).body.data;
    expect(profit.salesMinor).toBe("2750000");
    expect(profit.costOfSalesMinor).toBe("0");
    expect(profit.uncostedSalesMinor).toBe("2750000");
    expect(profit.estimatedProfitMinor).toBeNull();

    // Not an item: nothing remembered, nothing in the items sold.
    const saved = (await request(http).get("/api/v1/saved-items").set(auth(mama.token)).expect(200)).body.data.items;
    expect(saved).toHaveLength(0);
    const top = (await request(http).get("/api/v1/sales/top-items").set(auth(mama.token)).expect(200)).body.data.items;
    expect(top).toHaveLength(0);
  });

  it("goes to Sales in the books, moves no stock, and sits beside product lines in one sale", async () => {
    const ade = await shop(http, "amount-mixed@bizora.test", "Ade Stores");
    const riceId = await product(http, ade.token, "Rice 50kg", "5000000", "4", "bag");
    const mixed = await request(http)
      .post("/api/v1/sales")
      .set(auth(ade.token))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }, { amountMinor: "150000", description: "Pure water" }], payments: [{ method: "cash", amountMinor: "5150000" }] })
      .expect(201);
    expect(mixed.body.data.sale.totalMinor).toBe("5150000");
    const kinds = await client.query<{ line_kind: string; stock_movement_id: string | null; cost_minor: string | null }>(
      "SELECT line_kind, stock_movement_id, cost_minor FROM sale_lines WHERE sale_id = $1 ORDER BY line_no",
      [mixed.body.data.sale.id],
    );
    expect(kinds.rows.map((row) => row.line_kind)).toEqual(["product", "amount"]);
    expect(kinds.rows[1]).toMatchObject({ stock_movement_id: null, cost_minor: null });
    const stock = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE tenant_id = $1 AND product_id = $2", [ade.tenantId, riceId]);
    expect(stock.rows[0]?.quantity).toBe("3000");
    const credited = await client.query<{ code: string; credit: string }>(
      `SELECT a.code, sum(l.credit_minor)::text AS credit FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
       WHERE l.tenant_id = $1 AND l.credit_minor > 0 GROUP BY a.code`,
      [ade.tenantId],
    );
    // Both lines are sales of goods (4000), never service income or other money in.
    expect(credited.rows.find((row) => row.code === "4000")?.credit).toBe("5150000");
    expect(credited.rows.some((row) => row.code === "4900")).toBe(false);
  });

  it("is refused when the owner has switched it off, and an amount line can never name a product", async () => {
    const shopOff = await shop(http, "amount-off@bizora.test", "Products Only Ltd");
    await request(http).patch(`/api/v1/businesses/${shopOff.businessId}`).set(auth(shopOff.token)).send({ amountSales: false }).expect(200);
    const refused = await request(http).post("/api/v1/sales").set(auth(shopOff.token)).send(amountSale("100000", "cash")).expect(403);
    expect(refused.body.error.code).toBe("AMOUNT_SALES_OFF");
    const zero = await request(http).post("/api/v1/sales").set(auth(shopOff.token)).send(amountSale("0", "cash")).expect(400);
    expect(zero.body.error.code).toBe("VALIDATION_ERROR");

    const riceId = await product(http, shopOff.token, "Garri", "300000", "5", "bag");
    await request(http).patch(`/api/v1/businesses/${shopOff.businessId}`).set(auth(shopOff.token)).send({ amountSales: true }).expect(200);
    const ok = await request(http).post("/api/v1/sales").set(auth(shopOff.token)).send(amountSale("100000", "cash")).expect(201);
    await expect(
      client.query("UPDATE sale_lines SET product_id = $1 WHERE sale_id = $2", [riceId, ok.body.data.sale.id]),
    ).rejects.toThrow(/sale_lines_amount_ck/);
  });

  it("can be given back like any other sale: money out, nothing to stock", async () => {
    const back = await shop(http, "amount-return@bizora.test", "Return Kiosk");
    const sold = await request(http).post("/api/v1/sales").set(auth(back.token)).send(amountSale("500000", "cash", "Wrong change")).expect(201);
    const lineId = (await request(http).get(`/api/v1/sales/${sold.body.data.sale.id}`).set(auth(back.token)).expect(200)).body.data.sale.lines[0].id as string;
    await request(http)
      .post(`/api/v1/sales/${sold.body.data.sale.id}/returns`)
      .set(auth(back.token))
      .send({ id: uuidv7(), lines: [{ saleLineId: lineId, quantity: "1" }], refundMethod: "cash", reason: "Customer changed mind" })
      .expect(201);
    const returned = await client.query<{ back_to_stock: boolean; amount_minor: string }>("SELECT back_to_stock, amount_minor::text FROM sale_return_lines WHERE sale_line_id = $1", [lineId]);
    expect(returned.rows[0]).toMatchObject({ back_to_stock: false, amount_minor: "500000" });
  });

  it("works offline: the amount sale sent later is recorded once", async () => {
    const kiosk = await shop(http, "amount-offline@bizora.test", "Offline Kiosk");
    const saleId = uuidv7();
    const op = {
      id: uuidv7(),
      type: "sale.create",
      occurredAt: new Date().toISOString(),
      payload: { id: saleId, ...amountSale("250000", "cash", "Ogbono"), provisionalNumber: "DEV1-000001", soldAt: new Date(Date.now() - 60_000).toISOString() },
    };
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(kiosk.token)).send({ operations: [op] }).expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    const again = await request(http).post("/api/v1/sync/push").set(auth(kiosk.token)).send({ operations: [op] }).expect(200);
    expect(again.body.data.results[0].status).toBe("duplicate");
    const sale = (await request(http).get(`/api/v1/sales/${saleId}`).set(auth(kiosk.token)).expect(200)).body.data.sale;
    expect(sale.lines[0]).toMatchObject({ description: "Ogbono", lineKind: "amount" });
  });
});
