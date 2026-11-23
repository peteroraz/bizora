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
  THROTTLE_AUTH_LIMIT: 200,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  DEFAULT_PLAN_CODE: "business",
};
const password = "LocalOnly!Passw0rd";
type Http = Parameters<typeof request>[0];

async function owner(http: Http, label: string) {
  const registered = await request(http)
    .post("/api/v1/auth/register")
    .send({ email: `owner.${label}@moves.test`, password, displayName: `Owner ${label}`, organizationName: `Shop ${label}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
    .expect(201);
  const token = registered.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: `Shop ${label}`, branchName: "Main" })
    .expect(200);
  const me = await request(http).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`).expect(200);
  return { token, tenantId: me.body.data.tenant.tenantId as string, businessId: me.body.data.tenant.businessId as string, branchId: me.body.data.tenant.branchId as string };
}

async function staff(http: Http, ownerToken: string, email: string, role: string, branchId: string, businessId: string) {
  const invited = await request(http).post("/api/v1/invitations").set("authorization", `Bearer ${ownerToken}`).send({ email, role, businessId, branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  return (await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201)).body.data.accessToken as string;
}

describe("ADR-047: warehouses, transfers with a lifecycle, and count sessions", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Http;
  let a: Awaited<ReturnType<typeof owner>>;
  let b: Awaited<ReturnType<typeof owner>>;
  let warehouseId = "";
  let mainKeeper = "";
  let warehouseKeeper = "";
  let sales = "";
  let rice = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const quantityAt = async (productId: string, branchId: string) =>
    (await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1 AND branch_id = $2", [productId, branchId])).rows[0]?.quantity ?? "0";
  const valueOf = async (productId: string) => (await client.query<{ value: string }>("SELECT coalesce(sum(value_minor), 0)::text AS value FROM stock_balances WHERE product_id = $1", [productId])).rows[0]!.value;
  const books = async (tenantId: string) =>
    (await client.query<{ debit: string; credit: string }>("SELECT coalesce(sum(debit_minor), 0)::text AS debit, coalesce(sum(credit_minor), 0)::text AS credit FROM journal_lines WHERE tenant_id = $1", [tenantId])).rows[0]!;

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    a = await owner(http, "a");
    b = await owner(http, "b");
    const warehouse = await request(http).post("/api/v1/branches").set(auth(a.token)).send({ name: "Warehouse", kind: "warehouse" }).expect(201);
    warehouseId = warehouse.body.data.branch.id as string;
    mainKeeper = await staff(http, a.token, "keeper.main@moves.test", "INVENTORY", a.branchId, a.businessId);
    warehouseKeeper = await staff(http, a.token, "keeper.wh@moves.test", "INVENTORY", warehouseId, a.businessId);
    sales = await staff(http, a.token, "sales@moves.test", "SALES", a.branchId, a.businessId);
    // 100 bags in the warehouse at ₦60,000 each.
    rice = (await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000" }).expect(201)).body.data.product.id as string;
    await request(http).post("/api/v1/stock/receive").set(auth(a.token)).send({ productId: rice, branchId: warehouseId, quantity: "100", unit: "bag", totalCostMinor: "600000000", paidFrom: "cash" }).expect(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("does not sell from a warehouse at the counter", async () => {
    // A second sign-in, so choosing the warehouse does not end the owner's main one.
    const second = (await request(http).post("/api/v1/auth/login").send({ email: "owner.a@moves.test", password }).expect(201)).body.data.accessToken as string;
    const inWarehouse = (await request(http).post("/api/v1/auth/select-context").set(auth(second)).send({ organizationId: a.tenantId, businessId: a.businessId, branchId: warehouseId }).expect(201)).body.data.accessToken as string;
    const refused = await request(http)
      .post("/api/v1/sales")
      .set(auth(inWarehouse))
      .send({ lines: [{ productId: rice, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] })
      .expect(409);
    expect(refused.body.error.code).toBe("WAREHOUSE_NO_SALES");
  });

  it("asks, approves, sends and receives: the shop's stock rises only when it is received", async () => {
    // The warehouse store keeper cannot adjust stock, so the transfer waits for approval.
    const asked = await request(http)
      .post("/api/v1/inventory/transfers")
      .set(auth(warehouseKeeper))
      .send({ toBranchId: a.branchId, lines: [{ productId: rice, quantity: "10", unit: "bag" }], note: "For the weekend", dispatchNow: true })
      .expect(201);
    const transfer = asked.body.data.transfer;
    expect(transfer).toMatchObject({ status: "requested", number: expect.stringMatching(/^TR-/), from: { id: warehouseId, kind: "warehouse" }, to: { id: a.branchId } });
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/dispatch`).set(auth(warehouseKeeper)).expect(409);
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/approve`).set(auth(warehouseKeeper)).send({}).expect(403);
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/approve`).set(auth(a.token)).send({ note: "OK" }).expect(200);

    // Only someone at the sending place sends it.
    const wrongPlace = await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/dispatch`).set(auth(mainKeeper));
    expect(wrongPlace.status, JSON.stringify(wrongPlace.body)).toBe(404);
    const sent = await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/dispatch`).set(auth(warehouseKeeper)).expect(200);
    expect(sent.body.data.transfer.status).toBe("dispatched");
    expect(await quantityAt(rice, warehouseId)).toBe("90000");
    expect(await quantityAt(rice, a.branchId)).toBe("0");
    const inTransit = await request(http).get(`/api/v1/products/${rice}`).set(auth(a.token)).expect(200);
    expect(inTransit.body.data.product.inTransit).toEqual(expect.arrayContaining([{ branchId: a.branchId, incoming: "10000", outgoing: "0" }, { branchId: warehouseId, incoming: "0", outgoing: "10000" }]));
    // In transit, the value is in neither place, and nothing is posted: total stock value in the books is unchanged.
    expect(await valueOf(rice)).toBe("540000000");

    // Only someone at the receiving place receives it.
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/receive`).set(auth(warehouseKeeper)).send({}).expect(404);
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/cancel`).set(auth(a.token)).send({ reason: "Changed my mind" }).expect(409);
    const got = await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/receive`).set(auth(mainKeeper)).send({}).expect(200);
    expect(got.body.data.transfer).toMatchObject({ status: "received", lines: [{ quantity: "10000", receivedQuantity: "10000" }] });
    expect(await quantityAt(rice, a.branchId)).toBe("10000");
    expect(await valueOf(rice)).toBe("600000000");
    await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/receive`).set(auth(mainKeeper)).send({}).expect(409);
    const totals = await books(a.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it("records less arriving than was sent as missing, at the value that was sent", async () => {
    const made = await request(http).post("/api/v1/inventory/transfers").set(auth(a.token)).send({ fromBranchId: warehouseId, toBranchId: a.branchId, lines: [{ productId: rice, quantity: "5", unit: "bag" }], dispatchNow: true }).expect(201);
    const transfer = made.body.data.transfer;
    expect(transfer.status).toBe("dispatched");
    const lossesBefore = await client.query<{ value: string }>(
      "SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text AS value FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id WHERE jl.tenant_id = $1 AND la.code = '5100'",
      [a.tenantId],
    );
    await request(http)
      .post(`/api/v1/inventory/transfers/${transfer.id}/receive`)
      .set(auth(a.token))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: "6" }] })
      .expect(422);
    const got = await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/receive`).set(auth(a.token)).send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: "4" }], note: "One bag torn" }).expect(200);
    expect(got.body.data.transfer.lines[0]).toMatchObject({ quantity: "5000", receivedQuantity: "4000", valueMinor: "30000000" });
    expect(await quantityAt(rice, a.branchId)).toBe("14000");
    const missing = await client.query<{ reason: string; quantity: string; value: string }>("SELECT reason, quantity::text, value_minor::text AS value FROM stock_movements WHERE transfer_id = $1 AND movement_type = 'adjusted'", [transfer.id]);
    expect(missing.rows).toEqual([{ reason: "missing", quantity: "-1000", value: "-6000000" }]);
    const lossesAfter = await client.query<{ value: string }>(
      "SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text AS value FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id WHERE jl.tenant_id = $1 AND la.code = '5100'",
      [a.tenantId],
    );
    expect(BigInt(lossesAfter.rows[0]!.value) - BigInt(lossesBefore.rows[0]!.value)).toBe(6000000n);
    const totals = await books(a.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it("cancels before sending; refuses sending more than is on the shelf; keeps the quick way as a transfer too", async () => {
    const made = await request(http).post("/api/v1/inventory/transfers").set(auth(a.token)).send({ fromBranchId: warehouseId, toBranchId: a.branchId, lines: [{ productId: rice, quantity: "500", unit: "bag" }] }).expect(201);
    const tooMuch = await request(http).post(`/api/v1/inventory/transfers/${made.body.data.transfer.id}/dispatch`).set(auth(a.token)).expect(422);
    expect(tooMuch.body.error.code).toBe("NOT_ENOUGH_STOCK");
    await request(http).post(`/api/v1/inventory/transfers/${made.body.data.transfer.id}/cancel`).set(auth(a.token)).send({ reason: "Typed too many" }).expect(200);
    expect(await quantityAt(rice, warehouseId)).toBe("85000");

    // POST /stock/transfer (sent and received at once) shows in the transfer list.
    await request(http).post("/api/v1/stock/transfer").set(auth(a.token)).send({ productId: rice, fromBranchId: warehouseId, toBranchId: a.branchId, quantity: "1", unit: "bag" }).expect(201);
    const list = await request(http).get("/api/v1/inventory/transfers?status=received").set(auth(a.token)).expect(200);
    expect(list.body.data.transfers.length).toBe(3);
    // A shop-bound store keeper sees only transfers that reach or leave their shop.
    const keeperList = await request(http).get("/api/v1/inventory/transfers").set(auth(mainKeeper)).expect(200);
    expect(keeperList.body.data.transfers.every((row: { from: { id: string }; to: { id: string } }) => row.from.id === a.branchId || row.to.id === a.branchId)).toBe(true);
  });

  it("counts many products in one session, and posts the differences only when approved", async () => {
    const beans = (await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Beans 50kg", baseUnit: "bag", openingQuantity: "20", openingCostMinor: "100000000" }).expect(201)).body.data.product.id as string;
    const started = await request(http).post("/api/v1/inventory/counts").set(auth(mainKeeper)).send({ id: uuidv7(), name: "Month-end count" }).expect(201);
    const id = started.body.data.count.id as string;
    expect(started.body.data.count).toMatchObject({ status: "counting", branch: { id: a.branchId } });
    await request(http).post(`/api/v1/inventory/counts/${id}/submit`).set(auth(mainKeeper)).expect(422);
    await request(http).post(`/api/v1/inventory/counts/${id}/lines`).set(auth(mainKeeper)).send({ productId: rice, countedQuantity: "15", unit: "bag" }).expect(200);
    // Counting again replaces the line.
    await request(http).post(`/api/v1/inventory/counts/${id}/lines`).set(auth(mainKeeper)).send({ productId: rice, countedQuantity: "14", unit: "bag", reason: "damaged", note: "One bag wet" }).expect(200);
    const counted = await request(http).post(`/api/v1/inventory/counts/${id}/lines`).set(auth(mainKeeper)).send({ productId: beans, countedQuantity: "20", unit: "bag" }).expect(200);
    expect(counted.body.data.count.lines).toEqual([
      expect.objectContaining({ productId: rice, systemQuantity: "15000", countedQuantity: "14000", difference: "-1000", reason: "damaged" }),
      expect.objectContaining({ productId: beans, systemQuantity: "20000", countedQuantity: "20000", difference: "0", reason: null }),
    ]);
    await request(http).post(`/api/v1/inventory/counts/${id}/submit`).set(auth(mainKeeper)).expect(200);
    // Nothing changes until approval; the counter cannot approve.
    expect(await quantityAt(rice, a.branchId)).toBe("15000");
    await request(http).post(`/api/v1/inventory/counts/${id}/lines`).set(auth(mainKeeper)).send({ productId: rice, countedQuantity: "1", unit: "bag" }).expect(409);
    await request(http).post(`/api/v1/inventory/counts/${id}/approve`).set(auth(mainKeeper)).send({}).expect(403);
    await request(http).post(`/api/v1/inventory/counts/${id}/reject`).set(auth(a.token)).send({ note: "x" }).expect(400);
    await request(http).post(`/api/v1/inventory/counts/${id}/reject`).set(auth(a.token)).send({ note: "Count the beans in the back too" }).expect(200);
    await request(http).post(`/api/v1/inventory/counts/${id}/submit`).set(auth(mainKeeper)).expect(200);
    const posted = await request(http).post(`/api/v1/inventory/counts/${id}/approve`).set(auth(a.token)).send({ note: "Checked" }).expect(200);
    expect(posted.body.data.count.status).toBe("posted");
    expect(await quantityAt(rice, a.branchId)).toBe("14000");
    const movements = await client.query<{ movement_type: string; quantity: string; reason: string }>(
      "SELECT movement_type, quantity::text, reason FROM stock_movements WHERE count_id IN (SELECT id FROM stock_count_session_lines WHERE session_id = $1)",
      [id],
    );
    expect(movements.rows).toEqual([{ movement_type: "counted", quantity: "-1000", reason: "damaged" }]);
    await request(http).post(`/api/v1/inventory/counts/${id}/approve`).set(auth(a.token)).send({}).expect(409);
    const totals = await books(a.tenantId);
    expect(totals.debit).toBe(totals.credit);
    const logged = await client.query<{ action: string }>("SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at", [id]);
    expect(logged.rows.map((row) => row.action)).toEqual(["stock.count_session_started", "stock.count_session_submitted", "stock.count_session_returned", "stock.count_session_submitted", "stock.count_session_posted"]);
  });

  it("keeps sales staff out of transfers and counts", async () => {
    await request(http).post("/api/v1/inventory/transfers").set(auth(sales)).send({ toBranchId: warehouseId, lines: [{ productId: rice, quantity: "1", unit: "bag" }] }).expect(403);
    await request(http).post("/api/v1/inventory/counts").set(auth(sales)).send({ name: "Not mine" }).expect(403);
  });

  it("never lets one business see or act on another's transfers and counts, or send to its shops", async () => {
    const transfer = (await request(http).get("/api/v1/inventory/transfers").set(auth(a.token)).expect(200)).body.data.transfers[0];
    const count = (await request(http).get("/api/v1/inventory/counts").set(auth(a.token)).expect(200)).body.data.counts[0];
    await request(http).get(`/api/v1/inventory/transfers/${transfer.id}`).set(auth(b.token)).expect(404);
    for (const [action, body] of [
      ["approve", {}],
      ["dispatch", {}],
      ["receive", {}],
      ["cancel", { reason: "Not mine at all" }],
    ] as const) {
      const response = await request(http).post(`/api/v1/inventory/transfers/${transfer.id}/${action}`).set(auth(b.token)).send(body);
      expect(response.status, action).toBe(404);
    }
    await request(http).get(`/api/v1/inventory/counts/${count.id}`).set(auth(b.token)).expect(404);
    for (const [action, body] of [
      ["lines", { productId: rice, countedQuantity: "1", unit: "bag" }],
      ["submit", {}],
      ["approve", {}],
      ["reject", { note: "Not mine at all" }],
      ["cancel", {}],
    ] as const) {
      const response = await request(http).post(`/api/v1/inventory/counts/${count.id}/${action}`).set(auth(b.token)).send(body);
      expect(response.status, action).toBe(404);
    }
    // B cannot send to A's shop, nor send A's product.
    const bRice = (await request(http).post("/api/v1/products").set(auth(b.token)).send({ name: "B rice", baseUnit: "bag", openingQuantity: "5" }).expect(201)).body.data.product.id as string;
    await request(http).post("/api/v1/inventory/transfers").set(auth(b.token)).send({ toBranchId: a.branchId, lines: [{ productId: bRice, quantity: "1", unit: "bag" }] }).expect(404);
    const bShop = (await request(http).post("/api/v1/branches").set(auth(b.token)).send({ name: "B second" }).expect(201)).body.data.branch.id as string;
    await request(http).post("/api/v1/inventory/transfers").set(auth(b.token)).send({ toBranchId: bShop, lines: [{ productId: rice, quantity: "1", unit: "bag" }] }).expect(404);
    expect((await request(http).get("/api/v1/inventory/transfers").set(auth(b.token)).expect(200)).body.data.transfers).toEqual([]);
    // The database refuses a line for another business's product.
    await expect(
      client.query("INSERT INTO stock_transfer_lines (id, tenant_id, business_id, transfer_id, line_no, product_id, quantity, entered_quantity, entered_unit) VALUES ($1, $2, $3, $4, 9, $5, 1000, 1000, 'bag')", [uuidv7(), b.tenantId, b.businessId, transfer.id, rice]),
    ).rejects.toThrow();
  });
});
