import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { uuidv7 } from "@bizora/contracts";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import { LedgerPostingService } from "./modules/ledger/ledger-posting.service.js";
import type { AppDatabase } from "./db/database.js";

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
const CHOOSE_SHOP = "Choose which shop's cash paid this, or choose bank.";

type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string) {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@warehouse-cash.test`,
      password,
      displayName: `Owner ${label}`,
      organizationName: `Shop ${label}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode: "general-retail",
    })
    .expect(201);
  const token = owner.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set("authorization", `Bearer ${token}`)
    .send({
      countryCode: "NG",
      industryCode: "general-retail",
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

describe("warehouses do not hold cash (ADR-056)", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: AppDatabase;
  let ledger: LedgerPostingService;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let other: Awaited<ReturnType<typeof registerOwner>>;
  let singerId = "";
  let warehouseId = "";
  let productId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    ledger = app.get(LedgerPostingService);
    const http = app.getHttpServer();
    owner = await registerOwner(http, "singer");
    other = await registerOwner(http, "other");
    singerId = (
      await request(http).post("/api/v1/branches").set(auth(owner.token)).send({ name: "Singer market", kind: "shop" }).expect(201)
    ).body.data.branch.id as string;
    warehouseId = (
      await request(http).post("/api/v1/branches").set(auth(owner.token)).send({ name: "Depot", kind: "warehouse" }).expect(201)
    ).body.data.branch.id as string;
    productId = (
      await request(http)
        .post("/api/v1/products")
        .set(auth(owner.token))
        .send({ name: "Salt", baseUnit: "bag", priceMinor: "100000", openingQuantity: "1", openingCostMinor: "50000" })
        .expect(201)
    ).body.data.product.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function cashNet(branchId: string) {
    const rows = await client.query<{ net: string }>(
      `SELECT coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::text AS net
       FROM ledger_accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = a.tenant_id
       WHERE a.role = 'cash' AND a.branch_id = $1`,
      [branchId],
    );
    return rows.rows[0]?.net ?? "0";
  }

  it("pays a warehouse delivery from Singer market's cash and leaves the warehouse with no cash account", async () => {
    const http = app.getHttpServer();
    const before = await cashNet(singerId);
    const created = await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(owner.token))
      .send({
        branchId: warehouseId,
        paidFrom: "credit",
        paidFromBranchId: singerId,
        lines: [{ productId, quantity: "2", unit: "bag", totalCostMinor: "10000000" }],
        charges: [{ kind: "transport", amountMinor: "200000", paidFrom: "cash" }],
      })
      .expect(201);
    expect(created.body.data.chargesMinor).toBe("200000");
    expect(await cashNet(singerId)).toBe((BigInt(before) + 200000n).toString());
    const afterCharges = await cashNet(singerId);
    await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(owner.token))
      .send({ productId, branchId: warehouseId, quantity: "1", unit: "bag", totalCostMinor: "150000", paidFrom: "cash", paidFromBranchId: singerId })
      .expect(201);
    expect(await cashNet(singerId)).toBe((BigInt(afterCharges) + 150000n).toString());
    const warehouseCash = await client.query("SELECT id FROM ledger_accounts WHERE role = 'cash' AND branch_id = $1", [warehouseId]);
    expect(warehouseCash.rows).toEqual([]);
    const cash = await request(http).get("/api/v1/money/cash").set(auth(owner.token)).expect(200);
    const names = (cash.body.data.shops as { name: string }[]).map((shop) => shop.name);
    expect(names).toContain("Singer market");
    expect(names).not.toContain("Depot");
  });

  it("refuses cash at a warehouse when no shop is named", async () => {
    const http = app.getHttpServer();
    const refused = await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(owner.token))
      .send({
        branchId: warehouseId,
        paidFrom: "cash",
        lines: [{ productId, quantity: "1", unit: "bag", totalCostMinor: "100000" }],
      })
      .expect(400);
    expect(refused.body.error.message).toBe(CHOOSE_SHOP);
    const charge = await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(owner.token))
      .send({ productId, branchId: warehouseId, quantity: "1", unit: "bag", totalCostMinor: "100000", paidFrom: "cash" })
      .expect(400);
    expect(charge.body.error.message).toBe(CHOOSE_SHOP);
    await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(owner.token))
      .send({ productId, branchId: warehouseId, quantity: "1", unit: "bag", totalCostMinor: "100000", paidFrom: "bank" })
      .expect(201);
  });

  it("lets a shop receive its own stock from its own cash", async () => {
    const http = app.getHttpServer();
    const before = await cashNet(singerId);
    await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(owner.token))
      .send({ productId, branchId: singerId, quantity: "1", unit: "bag", totalCostMinor: "400000", paidFrom: "cash" })
      .expect(201);
    expect(await cashNet(singerId)).toBe((BigInt(before) + 400000n).toString());
    const accounts = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_accounts WHERE role = 'cash' AND branch_id = $1",
      [singerId],
    );
    expect(accounts.rows[0]?.n).toBe("1");
  });

  it("does not take cash from another business's shop", async () => {
    const http = app.getHttpServer();
    const before = await cashNet(other.branchId);
    const refused = await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(owner.token))
      .send({
        branchId: warehouseId,
        paidFrom: "credit",
        paidFromBranchId: other.branchId,
        lines: [{ productId, quantity: "1", unit: "bag", totalCostMinor: "100000" }],
        charges: [{ kind: "transport", amountMinor: "1000", paidFrom: "cash" }],
      })
      .expect(404);
    expect(refused.body.error.code).toBe("BRANCH_NOT_FOUND");
    expect(await cashNet(other.branchId)).toBe(before);
  });

  it("keeps an old warehouse cash balance visible and refuses a warehouse count", async () => {
    const http = app.getHttpServer();
    const today = (await request(http).get("/api/v1/money/cash").set(auth(owner.token)).expect(200)).body.data.today as string;
    const accountId = uuidv7();
    await client.query(
      `INSERT INTO ledger_accounts (id, tenant_id, business_id, branch_id, code, name, account_type, role, is_system, created_at, updated_at)
       SELECT $1, tenant_id, business_id, $2, '1000-99', 'Cash at Depot', 'asset', 'cash', true, now(), now()
       FROM ledger_accounts WHERE branch_id = $3 AND role = 'cash' LIMIT 1`,
      [accountId, warehouseId, singerId],
    );
    const capital = await client.query<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE business_id = $1 AND role = 'capital' LIMIT 1",
      [owner.businessId],
    );
    await db.transaction((tx) =>
      ledger.post(
        tx,
        { tenantId: owner.tenantId, userId: null },
        {
          businessId: owner.businessId,
          branchId: warehouseId,
          entryDate: today,
          source: { type: "opening", id: uuidv7() },
          postingKey: `warehouse-old:${warehouseId}`,
          description: "Cash already at the warehouse",
          lines: [
            { account: { id: accountId }, debitMinor: 50000n },
            { account: { id: capital.rows[0]!.id }, creditMinor: 50000n },
          ],
        },
      ),
    );
    const cash = await request(http).get("/api/v1/money/cash").set(auth(owner.token)).expect(200);
    const depot = (cash.body.data.shops as { name: string; note: string | null; expectedMinor: string }[]).find((shop) => shop.name === "Depot");
    expect(depot?.note).toBe("This warehouse still has cash from before. Move it under Money › Move money.");
    expect(depot?.expectedMinor).toBe("50000");
    const counted = await request(http)
      .post("/api/v1/money/cash-counts")
      .set(auth(owner.token))
      .send({ branchId: warehouseId, countedMinor: "50000" })
      .expect(400);
    expect(counted.body.error.message).toContain("warehouse");
    const still = await client.query<{ debit: string }>(
      "SELECT debit_minor::text AS debit FROM journal_lines WHERE account_id = $1",
      [accountId],
    );
    expect(still.rows[0]?.debit).toBe("50000");
  });
});
