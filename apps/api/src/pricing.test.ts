import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { spreadByWeight, uuidv7 } from "@bizora/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { LedgerPostingService } from "./modules/ledger/ledger-posting.service.js";
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
};

const password = "LocalOnly!Passw0rd";

type Http = Parameters<typeof request>[0];

async function registerOwner(http: Http, label: string, industryCode = "general-retail") {
  const owner = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email: `owner.${label}@offline.test`,
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


describe("price lists, suppliers per product and landed cost (ADR-048)", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let salesToken = "";
  let riceId = "";
  let beansId = "";
  let listId = "";
  let customerId = "";
  let supplierA = "";
  let supplierB = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "pa");
    b = await registerOwner(http, "pb");
    ledger = app.get(LedgerPostingService);
    salesToken = await invite(http, a.token, "sales@pricing.test", "SALES", a.branchId, a.businessId);
    const rice = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({ id: uuidv7(), name: "Rice 50kg", baseUnit: "bag", priceMinor: "8500000", openingQuantity: "40", openingCostMinor: "300000000" })
      .expect(201);
    riceId = rice.body.data.product.id;
    const beans = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({ id: uuidv7(), name: "Beans 50kg", baseUnit: "bag", priceMinor: "6000000", openingQuantity: "5", openingCostMinor: "25000000" })
      .expect(201);
    beansId = beans.body.data.product.id;
    const customer = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ name: "Alhaji Wholesale", phone: "08031112222" }).expect(201);
    customerId = customer.body.data.customer.id;
    supplierA = (await request(http).post("/api/v1/suppliers").set(auth(a.token)).send({ name: "Dangote Depot" }).expect(201)).body.data.supplier.id;
    supplierB = (await request(http).post("/api/v1/suppliers").set(auth(a.token)).send({ name: "Kano Grains" }).expect(201)).body.data.supplier.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("spreads charges over goods in whole kobo that add up exactly", () => {
    expect(spreadByWeight(100001n, [30000000n, 10000000n])).toEqual([75001n, 25000n]);
    expect(spreadByWeight(10n, [1n, 1n, 1n]).reduce((sum, part) => sum + part, 0n)).toBe(10n);
    expect(spreadByWeight(0n, [5n])).toEqual([0n]);
    expect(spreadByWeight(7n, [0n, 0n])).toEqual([0n, 0n]);
  });

  it("lets a manager make a price list with prices by quantity, and keeps staff out", async () => {
    const http = app.getHttpServer();
    await request(http).post("/api/v1/pricing/lists").set(auth(salesToken)).send({ name: "Wholesale" }).expect(403);
    const created = await request(http).post("/api/v1/pricing/lists").set(auth(a.token)).send({ name: "Wholesale" }).expect(201);
    listId = created.body.data.id;
    expect(created.body.data).toMatchObject({ name: "Wholesale", currency: "NGN", active: true, staffCanChoose: false });
    const duplicate = await request(http).post("/api/v1/pricing/lists").set(auth(a.token)).send({ name: " wholesale " }).expect(409);
    expect(duplicate.body.error.code).toBe("DUPLICATE_NAME");
    await request(http).post("/api/v1/pricing/lists").set(auth(a.token)).send({ name: "Dollars", currencyCode: "USD" }).expect(400);

    const wrongUnit = await request(http)
      .put(`/api/v1/pricing/lists/${listId}/prices`)
      .set(auth(a.token))
      .send({ prices: [{ productId: riceId, unitCode: "carton", priceMinor: "100" }] })
      .expect(400);
    expect(wrongUnit.body.error.code).toBe("UNIT_NOT_FOUND");
    await request(http)
      .put(`/api/v1/pricing/lists/${listId}/prices`)
      .set(auth(a.token))
      .send({
        prices: [
          { productId: riceId, unitCode: "bag", priceMinor: "8000000" },
          { productId: riceId, unitCode: "bag", minQuantity: "10", priceMinor: "7800000" },
          // An offer that ended yesterday is not used.
          { productId: beansId, unitCode: "bag", priceMinor: "1000000", effectiveFrom: day(-10), effectiveTo: day(-1) },
        ],
      })
      .expect(200);
    // The same price again changes it rather than adding another.
    await request(http).put(`/api/v1/pricing/lists/${listId}/prices`).set(auth(a.token)).send({ prices: [{ productId: riceId, unitCode: "bag", priceMinor: "8100000" }] }).expect(200);
    const prices = await request(http).get(`/api/v1/pricing/lists/${listId}/prices`).set(auth(a.token)).expect(200);
    expect(prices.body.data.prices).toHaveLength(3);
    expect(prices.body.data.prices.find((price: { minQuantity: string; productId: string }) => price.minQuantity === "1" && price.productId === riceId)).toMatchObject({ priceMinor: "8100000", everydayPriceMinor: "8500000" });

    // Staff see no list they may not use.
    const seen = await request(http).get("/api/v1/pricing/lists").set(auth(salesToken)).expect(200);
    expect(seen.body.data.lists).toEqual([]);
    const audit = await client.query<{ action: string }>(`SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'pricing.%' ORDER BY created_at`, [a.tenantId]);
    expect(audit.rows.map((row) => row.action)).toEqual(["pricing.list.created", "pricing.prices.set", "pricing.prices.set"]);
  });

  it("prices one variant of an item and leaves the other at its everyday price", async () => {
    const http = app.getHttpServer();
    const made = await request(http)
      .post("/api/v1/catalog/items")
      .set(auth(a.token))
      .send({
        name: "Polo shirt",
        variants: [
          { variantLabel: "Black", baseUnit: "piece", priceMinor: "500000", openingQuantity: "5", openingCostMinor: "1000000" },
          { variantLabel: "White", baseUnit: "piece", priceMinor: "450000", openingQuantity: "5", openingCostMinor: "1000000" },
        ],
      })
      .expect(201);
    const variants = made.body.data.item.variants as { id: string; name: string }[];
    const black = variants.find((variant) => variant.name.includes("Black"));
    const white = variants.find((variant) => variant.name.includes("White"));
    if (!black || !white) throw new Error(JSON.stringify(variants));
    const list = (await request(http).post("/api/v1/pricing/lists").set(auth(a.token)).send({ name: "Shirt wholesale" }).expect(201)).body.data.id as string;
    await request(http)
      .put(`/api/v1/pricing/lists/${list}/prices`)
      .set(auth(a.token))
      .send({ prices: [{ productId: black.id, unitCode: "piece", priceMinor: "400000" }] })
      .expect(200);
    const sale = await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({
        priceListId: list,
        lines: [
          { productId: black.id, quantity: "1", unit: "piece" },
          { productId: white.id, quantity: "1", unit: "piece" },
        ],
        payments: [{ method: "cash", amountMinor: "850000" }],
      })
      .expect(201);
    // Black uses the list (₦4,000). White is not on the list, so it stays at ₦4,500.
    expect(sale.body.data.sale.subtotalMinor).toBe("850000");
    const stored = await client.query<{ price_list_id: string | null }>("SELECT price_list_id FROM sales WHERE id = $1", [sale.body.data.sale.id]);
    expect(stored.rows[0]?.price_list_id).toBe(list);
  });

  it("adds delivery charges to stock kept in a warehouse", async () => {
    const http = app.getHttpServer();
    const warehouseId = (await request(http).post("/api/v1/branches").set(auth(a.token)).send({ name: "Warehouse", kind: "warehouse" }).expect(201)).body.data.branch.id as string;
    const hauled = (await request(http).post("/api/v1/products").set(auth(a.token)).send({ name: "Warehouse salt", baseUnit: "bag", priceMinor: "100000", openingQuantity: "1", openingCostMinor: "50000" }).expect(201)).body.data.product.id as string;
    const haulier = (await request(http).post("/api/v1/suppliers").set(auth(a.token)).send({ name: "Warehouse Haulage" }).expect(201)).body.data.supplier.id as string;
    const shopBefore = (await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1 AND branch_id = $2", [hauled, a.branchId])).rows[0]?.quantity;
    const created = await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(a.token))
      .send({
        id: uuidv7(),
        branchId: warehouseId,
        supplierId: haulier,
        paidFrom: "credit",
        paidFromBranchId: a.branchId,
        lines: [{ productId: hauled, quantity: "2", unit: "bag", totalCostMinor: "10000000" }],
        charges: [{ kind: "transport", amountMinor: "200000", paidFrom: "cash" }],
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ goodsMinor: "10000000", chargesMinor: "200000" });
    const held = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1 AND branch_id = $2", [hauled, warehouseId]);
    expect(held.rows[0]?.quantity).toBe("2000");
    const shopAfter = (await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1 AND branch_id = $2", [hauled, a.branchId])).rows[0]?.quantity;
    expect(shopAfter).toBe(shopBefore);
    const warehouseCash = await client.query("SELECT id FROM ledger_accounts WHERE role = 'cash' AND branch_id = $1", [warehouseId]);
    expect(warehouseCash.rows).toEqual([]);
  });

  it("sells to a customer at their list's prices, by quantity, and at everyday prices otherwise", async () => {
    const http = app.getHttpServer();
    await request(http).put(`/api/v1/customers/${customerId}/price-list`).set(auth(salesToken)).send({ priceListId: listId }).expect(403);
    await request(http).put(`/api/v1/customers/${customerId}/price-list`).set(auth(a.token)).send({ priceListId: listId }).expect(200);

    const few = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ customerId, lines: [{ productId: riceId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "16200000" }] })
      .expect(201);
    expect(few.body.data.sale.subtotalMinor).toBe("16200000");
    const many = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ customerId, lines: [{ productId: riceId, quantity: "10", unit: "bag" }, { productId: beansId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "84000000" }] })
      .expect(201);
    // 10 bags at the from-10 price; beans at the everyday price because the offer ended.
    expect(many.body.data.sale.subtotalMinor).toBe("84000000");
    const stored = await client.query<{ price_list_id: string | null }>(`SELECT price_list_id FROM sales WHERE id = $1`, [many.body.data.sale.id]);
    expect(stored.rows[0]?.price_list_id).toBe(listId);

    const walkIn = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8500000" }] })
      .expect(201);
    expect(walkIn.body.data.sale.subtotalMinor).toBe("8500000");

    // Below the list price is a discount: a manager's decision.
    await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ customerId, lines: [{ productId: riceId, quantity: "1", unit: "bag", unitPriceMinor: "7000000" }], payments: [{ method: "cash", amountMinor: "7000000" }] })
      .expect(403);
  });

  it("lets staff choose a list only when the owner allows it, and falls back when a list is switched off", async () => {
    const http = app.getHttpServer();
    const refused = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ priceListId: listId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8100000" }] })
      .expect(403);
    expect(refused.body.error.message).toContain("Wholesale");
    await request(http).patch(`/api/v1/pricing/lists/${listId}`).set(auth(a.token)).send({ staffCanChoose: true }).expect(200);
    expect((await request(http).get("/api/v1/pricing/lists").set(auth(salesToken)).expect(200)).body.data.lists).toHaveLength(1);
    const chosen = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ priceListId: listId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8100000" }] })
      .expect(201);
    expect(chosen.body.data.sale.subtotalMinor).toBe("8100000");

    await request(http).patch(`/api/v1/pricing/lists/${listId}`).set(auth(a.token)).send({ active: false }).expect(200);
    const customerSale = await request(http)
      .post("/api/v1/sales")
      .set(auth(salesToken))
      .send({ customerId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8500000" }] })
      .expect(201);
    expect(customerSale.body.data.sale.subtotalMinor).toBe("8500000");
    const notHere = await request(http)
      .post("/api/v1/sales")
      .set(auth(a.token))
      .send({ priceListId: listId, lines: [{ productId: riceId, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "8500000" }] })
      .expect(409);
    expect(notHere.body.error.code).toBe("PRICE_LIST_NOT_HERE");
    await request(http).patch(`/api/v1/pricing/lists/${listId}`).set(auth(a.token)).send({ active: true }).expect(200);
  });

  it("tells the sale screen the prices a sale will use, and prices offline sales by what the phone used", async () => {
    const http = app.getHttpServer();
    const screen = await request(http).get("/api/v1/pricing/for-sale").query({ customerId }).set(auth(salesToken)).expect(200);
    expect(screen.body.data.priceList).toMatchObject({ id: listId, name: "Wholesale" });
    expect(screen.body.data.prices).toEqual(
      expect.arrayContaining([
        { productId: riceId, unitCode: "bag", minQuantity: "1", priceMinor: "8100000" },
        { productId: riceId, unitCode: "bag", minQuantity: "10", priceMinor: "7800000" },
      ]),
    );
    // The ended offer on beans is not offered.
    expect(screen.body.data.prices.some((price: { productId: string }) => price.productId === beansId)).toBe(false);
    expect((await request(http).get("/api/v1/pricing/for-sale").set(auth(salesToken)).expect(200)).body.data).toEqual({ priceList: null, prices: [] });

    const offline = (priceListId?: string) => ({
      id: uuidv7(),
      type: "sale.create",
      occurredAt: new Date().toISOString(),
      payload: {
        id: uuidv7(),
        customerId,
        ...(priceListId ? { priceListId } : {}),
        soldAt: new Date().toISOString(),
        lines: [{ productId: riceId, quantity: "1", unit: "bag" }],
        payments: [{ method: "cash", amountMinor: priceListId ? "8100000" : "8500000" }],
      },
    });
    // A phone that priced at everyday prices (the list was not known there) is not overcharged or refused.
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [offline(), offline(listId)] }).expect(200);
    expect(pushed.body.data.results.map((result: { status: string }) => result.status)).toEqual(["applied", "applied"]);
    expect(pushed.body.data.results.map((result: { result: { sale: { totalMinor: string } } }) => result.result.sale.totalMinor)).toEqual(["8500000", "8100000"]);
  });

  it("keeps several suppliers per product, one preferred, and finds a product by a supplier's code", async () => {
    const http = app.getHttpServer();
    await request(http).put(`/api/v1/suppliers/${supplierA}/products`).set(auth(salesToken)).send({ productId: riceId }).expect(403);
    await request(http).put(`/api/v1/suppliers/${supplierA}/products`).set(auth(a.token)).send({ productId: riceId, supplierSku: "DG-RICE-50", preferred: true, leadTimeDays: 3, minimumOrderQuantity: "20", purchaseUnit: "bag" }).expect(200);
    const both = await request(http).put(`/api/v1/suppliers/${supplierB}/products`).set(auth(a.token)).send({ productId: riceId, supplierSku: "KG-77", preferred: true }).expect(200);
    expect(both.body.data.suppliers.map((line: { supplierName: string; preferred: boolean }) => [line.supplierName, line.preferred])).toEqual([
      ["Kano Grains", true],
      ["Dangote Depot", false],
    ]);
    expect(both.body.data.suppliers[1]).toMatchObject({ supplierSku: "DG-RICE-50", leadTimeDays: 3, minimumOrderQuantity: "20" });
    const found = await request(http).get("/api/v1/products").query({ q: "dg-rice-50" }).set(auth(salesToken)).expect(200);
    expect(found.body.data.items.map((product: { id: string }) => product.id)).toEqual([riceId]);
  });

  it("records what a product last cost, per product and per supplier, when stock comes in", async () => {
    const http = app.getHttpServer();
    await request(http)
      .post("/api/v1/stock/receive")
      .set(auth(a.token))
      .send({ id: uuidv7(), productId: riceId, quantity: "5", unit: "bag", totalCostMinor: "40000000", supplierId: supplierA, paidFrom: "credit" })
      .expect(201);
    const owner = await request(http).get(`/api/v1/products/${riceId}/suppliers`).set(auth(a.token)).expect(200);
    expect(owner.body.data).toMatchObject({ lastPurchaseCostMinor: "8000000", lastLandedCostMinor: "8000000" });
    expect(owner.body.data.suppliers.find((line: { supplierId: string }) => line.supplierId === supplierA)).toMatchObject({ lastCostMinor: "8000000" });
    // Sales staff do not see costs.
    const staff = await request(http).get(`/api/v1/products/${riceId}/suppliers`).set(auth(salesToken)).expect(200);
    expect(staff.body.data).not.toHaveProperty("lastPurchaseCostMinor");
    expect(staff.body.data.suppliers[0]).not.toHaveProperty("lastCostMinor");
  });

  it("adds delivery charges to the stock value, pays them from cash and bank, and owes the supplier for the goods only", async () => {
    const http = app.getHttpServer();
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(salesToken))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag", totalCostMinor: "100" }] })
      .expect(403);
    const id = uuidv7();
    const payload = {
      id,
      supplierId: supplierB,
      paidFrom: "credit",
      lines: [
        { productId: riceId, quantity: "4", unit: "bag", totalCostMinor: "30000000" },
        { productId: beansId, quantity: "2", unit: "bag", totalCostMinor: "10000000" },
      ],
      charges: [
        { kind: "transport", amountMinor: "400000", paidFrom: "cash" },
        { kind: "customs", amountMinor: "100001", paidFrom: "bank" },
      ],
    };
    const created = await request(http).post("/api/v1/stock/receipts").set(auth(a.token)).send(payload).expect(201);
    expect(created.body.data).toMatchObject({ goodsMinor: "40000000", chargesMinor: "500001" });
    const lines = created.body.data.lines as { productId: string; valueMinor: string; chargesMinor: string; goodsMinor: string }[];
    const rice = lines.find((line) => line.productId === riceId);
    const beans = lines.find((line) => line.productId === beansId);
    expect(rice).toMatchObject({ goodsMinor: "30000000", chargesMinor: "375001" });
    expect(beans).toMatchObject({ goodsMinor: "10000000", chargesMinor: "125000" });
    // Sent again (a retry), nothing is added twice.
    const again = await request(http).post("/api/v1/stock/receipts").set(auth(a.token)).send(payload).expect(201);
    expect(again.body.data.lines).toHaveLength(2);

    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(after.accounts, "1300") - balance(before.accounts, "1300")).toBe(40_500_001n);
    expect(balance(after.accounts, "1000-01") - balance(before.accounts, "1000-01")).toBe(-400_000n);
    expect(balance(after.accounts, "1100") - balance(before.accounts, "1100")).toBe(-100_001n);
    expect(balance(after.accounts, "2000") - balance(before.accounts, "2000")).toBe(-40_000_000n);
    const owed = await client.query<{ total: string }>(`SELECT sum(amount_minor)::text AS total FROM supplier_entries WHERE tenant_id = $1 AND supplier_id = $2 AND kind = 'purchase'`, [a.tenantId, supplierB]);
    expect(owed.rows[0]?.total).toBe("40000000");

    const costs = await request(http).get(`/api/v1/products/${beansId}/suppliers`).set(auth(a.token)).expect(200);
    // ₦100,000 for 2 bags is ₦50,000 a bag; with ₦1,250 of charges, ₦50,625 landed.
    expect(costs.body.data).toMatchObject({ lastPurchaseCostMinor: "5000000", lastLandedCostMinor: "5062500" });
  });

  it("keeps every price list, price and supplier line inside its own business", async () => {
    const http = app.getHttpServer();
    await request(http).get(`/api/v1/pricing/lists/${listId}/prices`).set(auth(b.token)).expect(404);
    await request(http).patch(`/api/v1/pricing/lists/${listId}`).set(auth(b.token)).send({ name: "Mine" }).expect(404);
    await request(http).put(`/api/v1/pricing/lists/${listId}/prices`).set(auth(b.token)).send({ prices: [{ productId: riceId, unitCode: "bag", priceMinor: "1" }] }).expect(404);
    const bCustomer = await request(http).post("/api/v1/customers").set(auth(b.token)).send({ name: "Other buyer", phone: "08039998888" }).expect(201);
    await request(http).put(`/api/v1/customers/${bCustomer.body.data.customer.id}/price-list`).set(auth(b.token)).send({ priceListId: listId }).expect(404);
    await request(http).put(`/api/v1/customers/${customerId}/price-list`).set(auth(b.token)).send({ priceListId: null }).expect(404);
    const bList = (await request(http).post("/api/v1/pricing/lists").set(auth(b.token)).send({ name: "Wholesale" }).expect(201)).body.data.id;
    // Another business's product cannot be priced on this business's list.
    await request(http).put(`/api/v1/pricing/lists/${bList}/prices`).set(auth(b.token)).send({ prices: [{ productId: riceId, unitCode: "bag", priceMinor: "1" }] }).expect(404);
    const bRice = await request(http).post("/api/v1/products").set(auth(b.token)).send({ id: uuidv7(), name: "Rice", baseUnit: "bag", priceMinor: "100", openingQuantity: "1", openingCostMinor: "50" }).expect(201);
    await request(http)
      .post("/api/v1/sales")
      .set(auth(b.token))
      .send({ priceListId: listId, lines: [{ productId: bRice.body.data.product.id, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "100" }] })
      .expect(404);
    await request(http).put(`/api/v1/suppliers/${supplierA}/products`).set(auth(b.token)).send({ productId: bRice.body.data.product.id }).expect(404);
    await request(http).get(`/api/v1/products/${riceId}/suppliers`).set(auth(b.token)).expect(404);
    await request(http).get(`/api/v1/pricing/products/${riceId}`).set(auth(b.token)).expect(404);
    expect((await request(http).get("/api/v1/products").query({ q: "DG-RICE-50" }).set(auth(b.token)).expect(200)).body.data.items).toEqual([]);
    await request(http)
      .post("/api/v1/stock/receipts")
      .set(auth(b.token))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag", totalCostMinor: "100" }], charges: [{ kind: "transport", amountMinor: "10", paidFrom: "cash" }] })
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
