import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { expectBalancedBooks, staff, shop, type Shop } from "./test-support.js";

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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A calendar day in the shop's zone, offset from today. */
function lagosDay(offset: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86_400_000));
}

function push(http: Parameters<typeof request>[0], token: string, payload: Record<string, unknown>, operationId = uuidv7()) {
  return request(http)
    .post("/api/v1/sync/push")
    .set(auth(token))
    .send({ operations: [{ id: operationId, type: "sale.create", occurredAt: new Date().toISOString(), payload }] });
}

describe("offline sales are kept (ADR-050)", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let ada: Shop;
  let cashier = "";

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    ada = await shop(http, "owner@kept.test", "Ada Provisions");
    cashier = await staff(http, ada, "cashier@kept.test", "CASHIER");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("keeps an offline carton sale at the price the phone showed after the price goes up", async () => {
    const created = await request(http)
      .post("/api/v1/products")
      .set(auth(ada.token))
      .send({ name: "Indomie carton", baseUnit: "carton", priceMinor: "1150000", openingQuantity: "20", openingCostMinor: "16000000" })
      .expect(201);
    const productId = created.body.data.product.id as string;
    await request(http)
      .patch(`/api/v1/products/${productId}`)
      .set(auth(ada.token))
      .send({ name: "Indomie carton", baseUnit: "carton", priceMinor: "1200000", changeReason: "Supplier raised the price" })
      .expect(200);
    const saleId = uuidv7();
    const synced = await push(http, cashier, {
      id: saleId,
      branchId: ada.branchId,
      lines: [{ productId, quantity: "2", unit: "carton", unitPriceMinor: "1150000" }],
      payments: [{ method: "cash", amountMinor: "2300000" }],
      soldAt: new Date().toISOString(),
    }).expect(200);
    expect(synced.body.data.results[0].status).toBe("applied");
    const sale = await client.query<{ total: string; unit_price: string; line_total: string }>(
      "SELECT s.total_minor::text AS total, sl.unit_price_minor::text AS unit_price, sl.line_total_minor::text AS line_total FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id WHERE s.id = $1",
      [saleId],
    );
    expect(sale.rows[0]).toMatchObject({ total: "2300000", unit_price: "1150000", line_total: "2300000" });
    const books = await client.query<{ debit: string; credit: string; cash: string }>(
      `SELECT coalesce(sum(jl.debit_minor), 0)::text AS debit, coalesce(sum(jl.credit_minor), 0)::text AS credit,
              coalesce(sum(jl.debit_minor) FILTER (WHERE a.role = 'cash'), 0)::text AS cash
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
         JOIN ledger_accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
         WHERE je.source_id = $1`,
      [saleId],
    );
    expect(books.rows[0]).toMatchObject({ debit: "2300000", credit: "2300000", cash: "2300000" });
    await expectBalancedBooks(client, ada.tenantId);
    const told = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1 AND kind = 'sale.below_price' AND sale_id = $2", [ada.tenantId, saleId]);
    expect(told.rows[0]?.n).not.toBe("0");

    const live = await request(http)
      .post("/api/v1/sales")
      .set(auth(cashier))
      .send({ lines: [{ productId, quantity: "2", unit: "carton", unitPriceMinor: "1150000" }], payments: [{ method: "cash", amountMinor: "2300000" }] });
    expect(live.status).toBe(403);
    expect(live.body.error.message).toContain("below its price");
  });

  it("keeps an offline credit sale whose due date has passed by the time it syncs", async () => {
    const productId = (await request(http).post("/api/v1/products").set(auth(ada.token)).send({ name: "Peak tin", baseUnit: "tin", priceMinor: "500000", openingQuantity: "10", openingCostMinor: "3000000" }).expect(201)).body.data.product.id as string;
    const customerId = (await request(http).post("/api/v1/customers").set(auth(ada.token)).send({ name: "Mama Chika", phone: "08031110001", creditAllowed: true }).expect(201)).body.data.customer.id as string;
    const day = lagosDay(-1);
    const saleId = uuidv7();
    const synced = await push(http, cashier, {
      id: saleId,
      customerId,
      lines: [{ productId, quantity: "1", unit: "tin", unitPriceMinor: "500000" }],
      payments: [{ method: "cash", amountMinor: "200000" }],
      dueDate: day,
      comment: "Pays when she comes back",
      soldAt: `${day}T12:00:00+01:00`,
    }).expect(200);
    expect(synced.body.data.results[0].status).toBe("applied");
    const row = await client.query<{ due_date: string }>("SELECT due_date::text AS due_date FROM sales WHERE id = $1", [saleId]);
    expect(row.rows[0]?.due_date).toBe(day);
  });

  it("keeps an offline credit sale after the customer's approval is removed, and tells the owner", async () => {
    const productId = (await request(http).post("/api/v1/products").set(auth(ada.token)).send({ name: "Milk cup", baseUnit: "cup", priceMinor: "400000", openingQuantity: "10", openingCostMinor: "2000000" }).expect(201)).body.data.product.id as string;
    const customerId = (await request(http).post("/api/v1/customers").set(auth(ada.token)).send({ name: "Bola Ade", phone: "08031110002", creditAllowed: true }).expect(201)).body.data.customer.id as string;
    await request(http).patch(`/api/v1/customers/${customerId}/credit`).set(auth(ada.token)).send({ creditAllowed: false }).expect(200);
    const saleId = uuidv7();
    const synced = await push(http, cashier, {
      id: saleId,
      customerId,
      lines: [{ productId, quantity: "1", unit: "cup", unitPriceMinor: "400000" }],
      payments: [{ method: "cash", amountMinor: "100000" }],
      dueDate: lagosDay(7),
      soldAt: new Date().toISOString(),
    }).expect(200);
    expect(synced.body.data.results[0].status).toBe("applied");
    const comment = await client.query<{ body: string }>("SELECT body FROM sale_comments WHERE sale_id = $1", [saleId]);
    expect(comment.rows[0]?.body).toBe("Sold offline");
    const told = await client.query<{ reason: string; summary: string }>(
      "SELECT data->>'reason' AS reason, data->>'summary' AS summary FROM notifications WHERE tenant_id = $1 AND kind = 'sale.credit_offline' AND sale_id = $2",
      [ada.tenantId, saleId],
    );
    expect(told.rows[0]).toMatchObject({ reason: "not_approved", summary: "Bola Ade" });
  });

  it("records an offline sale in a shop that was closed after the sale", async () => {
    const stallId = (await request(http).post("/api/v1/branches").set(auth(ada.token)).send({ name: "Market stall" }).expect(201)).body.data.branch.id as string;
    const productId = (await request(http).post("/api/v1/products").set(auth(ada.token)).send({ name: "Soap", baseUnit: "piece", priceMinor: "300000", openingQuantity: "5", openingCostMinor: "1000000" }).expect(201)).body.data.product.id as string;
    await request(http).post(`/api/v1/branches/${stallId}/close`).set(auth(ada.token)).send({ reason: "Moved", moveToBranchId: ada.branchId }).expect(200);
    const saleId = uuidv7();
    const soldAt = new Date(Date.now() - 3_600_000).toISOString();
    const synced = await push(http, cashier, {
      id: saleId,
      branchId: stallId,
      lines: [{ productId, quantity: "1", unit: "piece", unitPriceMinor: "300000" }],
      payments: [{ method: "cash", amountMinor: "300000" }],
      soldAt,
    }).expect(200);
    expect(synced.body.data.results[0].status).toBe("applied");
    const row = await client.query<{ branch_id: string }>("SELECT branch_id FROM sales WHERE id = $1", [saleId]);
    expect(row.rows[0]?.branch_id).toBe(stallId);
    const told = await client.query<{ summary: string }>("SELECT data->>'summary' AS summary FROM notifications WHERE tenant_id = $1 AND kind = 'sale.closed_shop' AND sale_id = $2", [ada.tenantId, saleId]);
    expect(told.rows[0]?.summary).toBe("Market stall");
  });

  it("stores a refused sale for the owner, records it once, and hides it from another business", async () => {
    const productId = (await request(http).post("/api/v1/products").set(auth(ada.token)).send({ name: "Hidden rice", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "4", openingCostMinor: "2000000" }).expect(201)).body.data.product.id as string;
    await request(http).post(`/api/v1/products/${productId}/archive`).set(auth(ada.token)).send({ reason: "Off the shelf" }).expect(200);
    const saleId = uuidv7();
    const operationId = uuidv7();
    const payload = {
      id: saleId,
      branchId: ada.branchId,
      lines: [{ productId, quantity: "1", unit: "bag", unitPriceMinor: "1000000" }],
      payments: [{ method: "cash", amountMinor: "1000000" }],
      soldAt: new Date().toISOString(),
    };
    const refused = await push(http, cashier, payload, operationId).expect(200);
    expect(refused.body.data.results[0]).toMatchObject({ status: "rejected", stored: true });
    const problem = await client.query<{ id: string }>("SELECT id FROM sync_problems WHERE tenant_id = $1 AND operation_id = $2", [ada.tenantId, operationId]);
    const problemId = problem.rows[0]!.id;

    const other = await shop(http, "other@kept.test", "Other Shop");
    expect((await request(http).get("/api/v1/sales/problems").set(auth(other.token)).expect(200)).body.data.items).toEqual([]);
    await request(http).post(`/api/v1/sales/problems/${problemId}/record`).set(auth(other.token)).send({}).expect(404);
    await request(http).post(`/api/v1/sales/problems/${problemId}/dismiss`).set(auth(other.token)).send({ reason: "Not mine" }).expect(404);
    await request(http).get("/api/v1/sales/problems").set(auth(cashier)).expect(403);

    await client.query("UPDATE products SET archived_at = NULL WHERE id = $1", [productId]);
    const recorded = await request(http).post(`/api/v1/sales/problems/${problemId}/record`).set(auth(ada.token)).send({}).expect(200);
    expect(recorded.body.data.sale.id).toBe(saleId);
    const count = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM sales WHERE id = $1", [saleId]);
    expect(count.rows[0]?.n).toBe("1");
    const again = await push(http, cashier, payload, operationId).expect(200);
    expect(again.body.data.results[0].status).toBe("duplicate");
    expect((await client.query<{ n: string }>("SELECT count(*)::text AS n FROM sales WHERE id = $1", [saleId])).rows[0]?.n).toBe("1");
    expect((await request(http).get("/api/v1/sales/problems").set(auth(ada.token)).expect(200)).body.data.items.map((item: { id: string }) => item.id)).not.toContain(problemId);
  });
});
