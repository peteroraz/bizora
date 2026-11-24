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
  THROTTLE_AUTH_LIMIT: 100,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

describe("record first, organise later", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let businessId = "";
  let ogbonoId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sell = (token: string, lines: unknown[], total: string, extra: Record<string, unknown> = {}) =>
    request(http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({ lines, payments: [{ method: "cash", amountMinor: total }], ...extra });

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@quick.test", password, displayName: "Ada Owner", organizationName: "Ada Provisions", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Provisions", branchName: "Main" }).expect(200);
    cashier = await invite(http, owner, "girl@quick.test", "CASHIER", branchId, businessId);
    other = (await request(http).post("/api/v1/auth/register").send({ email: "other@quick.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true }).expect(201)).body.data.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets a new shop type a sale before any product exists", async () => {
    const settings = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data;
    expect(settings).toMatchObject({ salesItems: "both", rememberItems: true, quickCatalog: true, items: [] });
    const sold = await sell(cashier, [{ description: "Ogbono", quantity: "2", unit: "cup", unitPriceMinor: "100000", saved: true }], "200000").expect(201);
    const sale = sold.body.data.sale;
    expect(sale.customerId).toBeNull();
    expect(sale.totalMinor).toBe("200000");
    expect(sale.lines[0]).toMatchObject({ description: "Ogbono", enteredUnit: "cup", productId: null, lineKind: "quick", lineTotalMinor: "200000" });
    const people = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM customers WHERE business_id = $1", [businessId]);
    expect(people.rows[0]?.count).toBe("0");
    const credits = await client.query<{ role: string }>("SELECT a.role FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_id = $1 AND jl.credit_minor > 0", [sale.id]);
    expect(credits.rows.map((row) => row.role)).toEqual(["sales"]);
    const list = (await request(http).get("/api/v1/saved-items").set(auth(cashier)).expect(200)).body.data;
    ogbonoId = list.items[0].id as string;
    expect(list.items[0]).toMatchObject({ name: "Ogbono", unit: "cup", lastPriceMinor: "100000", timesSold: 1, source: "typed", catalogMode: "quick", productId: null });
    const units = (await request(http).get("/api/v1/units").set(auth(cashier)).expect(200)).body.data.units as { code: string }[];
    expect(units.map((unit) => unit.code)).not.toContain("cup");
  });

  it("suggests the item to another person from the first letters, and does not duplicate the name", async () => {
    const suggested = (await request(http).get("/api/v1/saved-items/suggest").query({ q: "Ogb" }).set(auth(owner)).expect(200)).body.data.items;
    expect(suggested[0]).toMatchObject({ name: "Ogbono", lastPriceMinor: "100000", unit: "cup", timesSold: 1 });
    await sell(cashier, [{ description: "ogbono", quantity: "1", unit: "cup", unitPriceMinor: "120000", saved: true }], "120000").expect(201);
    const units = (await request(http).get("/api/v1/units").set(auth(owner)).expect(200)).body.data.units as { code: string }[];
    expect(units.map((unit) => unit.code)).toContain("cup");
    await sell(owner, [{ description: "OGBONO", quantity: "1", unit: "cup", unitPriceMinor: "120000", saved: true }], "120000").expect(201);
    await sell(owner, [{ description: "Ogbono.", quantity: "1", unit: "cup", unitPriceMinor: "90000", saved: true }], "90000").expect(201);
    const list = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Ogbono", lastPriceMinor: "90000", timesSold: 4 });
  });

  it("imports a list of names, skips what is already there, and keeps one row when the same sale is sent twice", async () => {
    const preview = await request(http).post("/api/v1/saved-items/import").set(auth(owner)).send({ text: "Product\nOgbono\nEgusi\nCrayfish\nGarri" }).expect(200);
    expect(preview.body.data.dryRun).toBe(true);
    expect(preview.body.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Ogbono", status: "exists" }),
        expect.objectContaining({ name: "Egusi", status: "new" }),
        expect.objectContaining({ name: "Crayfish", status: "new" }),
        expect.objectContaining({ name: "Garri", status: "new" }),
      ]),
    );
    await request(http).post("/api/v1/saved-items/import").set(auth(cashier)).send({ text: "Egusi", dryRun: false }).expect(403);
    const added = await request(http).post("/api/v1/saved-items/import").set(auth(owner)).send({ text: "Product\nOgbono\nEgusi\nCrayfish\nGarri", dryRun: false }).expect(200);
    expect(added.body.data.added).toBe(3);
    const again = await request(http).post("/api/v1/saved-items/import").set(auth(owner)).send({ names: ["egusi", "Palm oil"], dryRun: false }).expect(200);
    expect(again.body.data.added).toBe(1);
    const id = uuidv7();
    const operationId = uuidv7();
    const payload = { id, lines: [{ description: "Uziza", quantity: "1", unit: "wrap", unitPriceMinor: "50000", saved: true }], payments: [{ method: "cash", amountMinor: "50000" }], soldAt: new Date().toISOString() };
    const push = () => request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [{ id: operationId, type: "sale.create", occurredAt: new Date().toISOString(), payload }] }).expect(200);
    expect((await push()).body.data.results[0].status).toBe("applied");
    expect((await push()).body.data.results[0].status).toBe("duplicate");
    const retried = await request(http).post("/api/v1/sync/push").set(auth(cashier)).send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload }] }).expect(200);
    expect(retried.body.data.results[0].status).toBe("applied");
    const sales = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM sales WHERE id = $1", [id]);
    expect(sales.rows[0]?.count).toBe("1");
    const names = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items.map((item: { name: string }) => item.name);
    expect(names.filter((name: string) => name.toLowerCase() === "uziza")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["Egusi", "Crayfish", "Garri", "Palm oil"]));
  });

  it("finds an item by another name, and merges two remembered items without rewriting the sale", async () => {
    await request(http).post(`/api/v1/saved-items/${ogbonoId}/aliases`).set(auth(cashier)).send({ alias: "Igbogbono" }).expect(403);
    await request(http).post(`/api/v1/saved-items/${ogbonoId}/aliases`).set(auth(owner)).send({ alias: "Igbogbono" }).expect(200);
    const byAlias = (await request(http).get("/api/v1/saved-items/suggest").query({ q: "Igbog" }).set(auth(cashier)).expect(200)).body.data.items;
    expect(byAlias[0]).toMatchObject({ name: "Ogbono" });
    const egusi = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items.find((item: { name: string }) => item.name === "Egusi");
    await sell(cashier, [{ description: "Egusi seed", quantity: "1", unit: "cup", unitPriceMinor: "80000", saved: true }], "80000").expect(201);
    const seed = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items.find((item: { name: string }) => item.name === "Egusi seed");
    const lineBefore = await client.query<{ description: string }>("SELECT description FROM sale_lines WHERE description = 'Egusi seed'");
    await request(http).post("/api/v1/saved-items/merge").set(auth(cashier)).send({ keepId: egusi.id, dropId: seed.id }).expect(403);
    await request(http).post("/api/v1/saved-items/merge").set(auth(owner)).send({ keepId: egusi.id, dropId: seed.id }).expect(200);
    const names = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items.map((item: { name: string }) => item.name);
    expect(names).toContain("Egusi");
    expect(names).not.toContain("Egusi seed");
    const lineAfter = await client.query<{ description: string }>("SELECT description FROM sale_lines WHERE description = 'Egusi seed'");
    expect(lineAfter.rows).toEqual(lineBefore.rows);
    const otherList = (await request(http).get("/api/v1/saved-items").set(auth(other)).expect(200)).body.data.items;
    expect(otherList).toEqual([]);
  });

  it("turns a remembered item into a product without changing the old sale, and does not invent a profit", async () => {
    const before = await client.query<{ description: string; product_id: string | null; line_total_minor: string }>("SELECT description, product_id, line_total_minor::text FROM sale_lines WHERE description = 'Ogbono' ORDER BY line_total_minor");
    await request(http).post(`/api/v1/saved-items/${ogbonoId}/upgrade`).set(auth(cashier)).send({ trackStock: true, openingQuantity: "4" }).expect(403);
    const upgraded = await request(http).post(`/api/v1/saved-items/${ogbonoId}/upgrade`).set(auth(owner)).send({ priceMinor: "100000", category: "Soup" }).expect(200);
    const after = await client.query<{ description: string; product_id: string | null; line_total_minor: string }>("SELECT description, product_id, line_total_minor::text FROM sale_lines WHERE description = 'Ogbono' ORDER BY line_total_minor");
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.every((row) => row.product_id === null)).toBe(true);
    const product = (await request(http).get(`/api/v1/products/${upgraded.body.data.productId}`).set(auth(owner)).expect(200)).body.data.product;
    expect(product).toMatchObject({ name: "Ogbono", trackStock: false });
    expect(product.stock.quantity).toBe("0");
    await request(http).post("/api/v1/saved-items/merge").set(auth(owner)).send({ keepId: ogbonoId, dropId: ogbonoId }).expect(400);
    const egusi = (await request(http).get("/api/v1/saved-items").set(auth(owner)).expect(200)).body.data.items.find((item: { name: string }) => item.name === "Egusi");
    await request(http).post("/api/v1/saved-items/merge").set(auth(owner)).send({ keepId: ogbonoId, dropId: egusi.id }).expect(409);
    const profit = (await request(http).get("/api/v1/money/profit").set(auth(owner)).expect(200)).body.data;
    expect(profit.profitStatus).toBe("unknown");
    expect(profit).not.toHaveProperty("knownProfitMinor");
    expect(profit.estimatedProfitMinor).toBeNull();
    expect(BigInt(profit.profitMinor)).toBeGreaterThan(0n);
    expect(BigInt(profit.salesMinor)).toBeGreaterThan(0n);
    const top = (await request(http).get("/api/v1/sales/top-items").set(auth(owner)).expect(200)).body.data.items as { name: string; costKnown: boolean; totalMinor: string }[];
    const row = top.find((item) => item.name === "Ogbono");
    expect(row?.costKnown).toBe(false);
    expect(BigInt(row?.totalMinor ?? "0")).toBeGreaterThan(0n);
    expect(row).not.toHaveProperty("marginMinor");
    await request(http).post(`/api/v1/saved-items/${ogbonoId}/cost-estimate`).set(auth(owner)).send({ estimatedCostMinor: "70000", periodStart: "2020-01-01", periodEnd: "2099-12-31", reason: "About 700 naira a cup in November" }).expect(200);
    const estimated = (await request(http).get("/api/v1/money/profit").set(auth(owner)).expect(200)).body.data;
    expect(estimated.profitStatus).toBe("unknown");
    expect(estimated.estimatedProfitMinor).not.toBeNull();
    expect(estimated.profitMinor).toBe(profit.profitMinor);
    expect(BigInt(estimated.estimatedProfitMinor)).toBeLessThan(BigInt(estimated.profitMinor));
  });

  it("sells a typed product name as that product, and still remembers a name that is not one", async () => {
    const branch = await client.query<{ id: string }>("SELECT id FROM branches WHERE business_id = $1 LIMIT 1", [businessId]);
    const sales = await invite(http, owner, "sales@quick.test", "SALES", branch.rows[0]?.id ?? "", businessId);
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(other))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Other Shop", branchName: "Main" })
      .expect(200);
    const foreign = await request(http)
      .post("/api/v1/products")
      .set(auth(other))
      .send({ name: "Foreign Rice", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "5", openingCostMinor: "4000000" })
      .expect(201);
    const foreignId = foreign.body.data.product.id as string;
    const notOurs = await sell(sales, [{ description: "foreign rice", quantity: "1", unit: "bag", unitPriceMinor: "1000000", saved: true }], "1000000").expect(201);
    expect(notOurs.body.data.sale.lines[0]).toMatchObject({ productId: null, lineKind: "quick", description: "foreign rice" });
    const foreignStock = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [foreignId]);
    expect(foreignStock.rows[0]?.quantity).toBe("5000");
    const ogbono = await sell(other, [{ description: "Ogbono", quantity: "2", unit: "cup", unitPriceMinor: "100000", saved: true }], "200000").expect(201);
    expect(ogbono.body.data.sale.lines[0]).toMatchObject({ productId: null, lineKind: "quick" });
    const remembered = await request(http).get("/api/v1/saved-items").set(auth(other)).expect(200);
    expect(remembered.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Ogbono", timesSold: 1 })]));

    const rice = await request(http)
      .post("/api/v1/products")
      .set(auth(owner))
      .send({ name: "Rice 50kg", baseUnit: "bag", priceMinor: "8500000", openingQuantity: "10", openingCostMinor: "75000000" })
      .expect(201);
    const riceId = rice.body.data.product.id as string;
    const below = await sell(sales, [{ description: "rice 50kg", quantity: "1", unit: "bag", unitPriceMinor: "8000000", saved: true }], "8000000");
    expect(below.status).toBe(403);
    expect(below.body.error.message).toContain("below its price");
    const wrongUnit = await sell(sales, [{ description: "Rice 50kg", quantity: "1", unit: "cup", unitPriceMinor: "8500000", saved: true }], "8500000");
    expect(wrongUnit.status).toBe(400);
    expect(wrongUnit.body.error.message).toBe("Rice 50kg is sold by the bag. Choose bag.");
    expect(wrongUnit.body.error.fieldErrors).toEqual([expect.objectContaining({ field: "lines.0.unit" })]);
    const sold = await sell(sales, [{ description: "rice 50kg", quantity: "1", unit: "bag", unitPriceMinor: "8500000", saved: true }], "8500000").expect(201);
    expect(sold.body.data.sale.lines[0]).toMatchObject({ productId: riceId, lineKind: "product", description: "Rice 50kg", lineTotalMinor: "8500000" });
    const line = await client.query<{ cost_minor: string; line_kind: string }>("SELECT cost_minor::text, line_kind FROM sale_lines WHERE sale_id = $1", [sold.body.data.sale.id]);
    expect(line.rows[0]).toMatchObject({ cost_minor: "7500000", line_kind: "product" });
    const afterOne = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [riceId]);
    expect(afterOne.rows[0]?.quantity).toBe("9000");
    const notSaved = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM saved_items WHERE business_id = $1 AND name_key = 'rice 50kg'", [businessId]);
    expect(notSaved.rows[0]?.count).toBe("0");

    const tenant = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM businesses WHERE id = $1", [businessId]);
    await client.query("INSERT INTO item_aliases (id, tenant_id, business_id, product_id, alias, alias_key) VALUES ($1, $2, $3, $4, 'Big rice', 'big rice')", [
      uuidv7(),
      tenant.rows[0]?.tenant_id,
      businessId,
      riceId,
    ]);
    const byAlias = await sell(sales, [{ description: "Big rice", quantity: "1", unit: "bag", unitPriceMinor: "8500000", saved: true }], "8500000").expect(201);
    expect(byAlias.body.data.sale.lines[0]).toMatchObject({ productId: riceId, lineKind: "product", description: "Rice 50kg" });
    const aliasCost = await client.query<{ cost_minor: string }>("SELECT cost_minor::text FROM sale_lines WHERE sale_id = $1", [byAlias.body.data.sale.id]);
    expect(aliasCost.rows[0]?.cost_minor).toBe("7500000");
    const afterAlias = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [riceId]);
    expect(afterAlias.rows[0]?.quantity).toBe("8000");

    const offlineId = uuidv7();
    const offline = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(sales))
      .send({
        operations: [
          {
            id: uuidv7(),
            type: "sale.create",
            occurredAt: new Date().toISOString(),
            payload: {
              id: offlineId,
              lines: [{ description: "rice 50kg", quantity: "1", unit: "bag", unitPriceMinor: "8000000", saved: true }],
              payments: [{ method: "cash", amountMinor: "8000000" }],
              soldAt: new Date().toISOString(),
            },
          },
        ],
      })
      .expect(200);
    expect(offline.body.data.results[0].status).toBe("applied");
    const kept = await client.query<{ product_id: string; line_kind: string; line_total_minor: string; unit_price_minor: string }>(
      "SELECT product_id, line_kind, line_total_minor::text, unit_price_minor::text FROM sale_lines WHERE sale_id = $1",
      [offlineId],
    );
    expect(kept.rows[0]).toMatchObject({ product_id: riceId, line_kind: "product", line_total_minor: "8000000", unit_price_minor: "8000000" });
    const flagged = await client.query<{ action: string }>("SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'sale.below_price'", [offlineId]);
    expect(flagged.rows).toHaveLength(1);
    const told = await client.query<{ kind: string }>("SELECT kind FROM notifications WHERE sale_id = $1", [offlineId]);
    expect(told.rows.map((row) => row.kind)).toContain("sale.below_price");
    const afterOffline = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [riceId]);
    expect(afterOffline.rows[0]?.quantity).toBe("7000");
    expect(foreignStock.rows[0]?.quantity).toBe("5000");
    const foreignAgain = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [foreignId]);
    expect(foreignAgain.rows[0]?.quantity).toBe("5000");

    const refused = await request(http)
      .post("/api/v1/sales")
      .set(auth(sales))
      .send({ lines: [{ productId: riceId, quantity: "1", unit: "bag", lineTotalMinor: "8500000" }], payments: [{ method: "cash", amountMinor: "8500000" }] });
    expect(refused.status).toBe(400);
  });

  it("records the typed line total, including when the sale syncs later", async () => {
    const cups = [{ description: "Dry pepper", quantity: "3", unit: "cup", unitPriceMinor: "66666", lineTotalMinor: "200000", saved: true }];
    const sold = await sell(cashier, cups, "200000").expect(201);
    expect(sold.body.data.sale.totalMinor).toBe("200000");
    expect(sold.body.data.sale.lines[0]).toMatchObject({ lineTotalMinor: "200000", unitPriceMinor: "66666", lineKind: "quick" });
    const books = await client.query<{ debit: string; credit: string; cash: string }>(
      `SELECT coalesce(sum(jl.debit_minor), 0)::text AS debit, coalesce(sum(jl.credit_minor), 0)::text AS credit,
              coalesce(sum(jl.debit_minor) FILTER (WHERE a.role = 'cash'), 0)::text AS cash
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
       JOIN ledger_accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
       WHERE je.source_id = $1`,
      [sold.body.data.sale.id],
    );
    expect(books.rows[0]).toMatchObject({ debit: "200000", credit: "200000", cash: "200000" });

    const offlineId = uuidv7();
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(cashier))
      .send({
        operations: [
          {
            id: uuidv7(),
            type: "sale.create",
            occurredAt: new Date().toISOString(),
            payload: { id: offlineId, lines: cups, payments: [{ method: "cash", amountMinor: "200000" }], soldAt: new Date().toISOString() },
          },
        ],
      })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    const synced = await client.query<{ total: string; line_total: string }>(
      "SELECT s.total_minor::text AS total, sl.line_total_minor::text AS line_total FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id WHERE s.id = $1",
      [offlineId],
    );
    expect(synced.rows[0]).toMatchObject({ total: "200000", line_total: "200000" });
    const syncedBooks = await client.query<{ debit: string; credit: string; cash: string }>(
      `SELECT coalesce(sum(jl.debit_minor), 0)::text AS debit, coalesce(sum(jl.credit_minor), 0)::text AS credit,
              coalesce(sum(jl.debit_minor) FILTER (WHERE a.role = 'cash'), 0)::text AS cash
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
       JOIN ledger_accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
       WHERE je.source_id = $1`,
      [offlineId],
    );
    expect(syncedBooks.rows[0]).toMatchObject({ debit: "200000", credit: "200000", cash: "200000" });
  });

  it("refuses a whole sale typed as one item's name at the counter, but keeps it from an offline phone (ADR-057)", async () => {
    const sentence = "20 bag of rice , 750,000, 3 cups of ogiri, 5500, 1 catoon of indomie, 15000, new customer";
    const refused = await sell(cashier, [{ description: sentence, quantity: "1", unit: "piece", unitPriceMinor: "100", saved: true }], "100").expect(400);
    expect(refused.body.error.code).toBe("ITEM_NAME_TOO_LONG");
    expect(refused.body.error.message).toContain("Read this as a sale");
    const offlineId = uuidv7();
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(cashier))
      .send({
        operations: [
          {
            id: uuidv7(),
            type: "sale.create",
            occurredAt: new Date().toISOString(),
            payload: { id: offlineId, lines: [{ description: sentence, quantity: "1", unit: "piece", unitPriceMinor: "100", saved: true }], payments: [{ method: "cash", amountMinor: "100" }], soldAt: new Date().toISOString() },
          },
        ],
      })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    // A name of 60 letters is still fine.
    await sell(cashier, [{ description: "A".repeat(60), quantity: "1", unit: "piece", unitPriceMinor: "100", saved: true }], "100").expect(201);
  });
});

async function invite(http: Parameters<typeof request>[0], ownerToken: string, email: string, role: string, branchId: string, businessId: string) {
  const invited = await request(http).post("/api/v1/invitations").set("authorization", `Bearer ${ownerToken}`).send({ email, role, businessId, branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}
