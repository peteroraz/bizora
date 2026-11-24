import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { compactItemKey, uuidv7 } from "@bizora/contracts";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
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

describe("near-match typed names", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let other = "";
  let businessId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sell = (token: string, description: string, total = "500000", unit = "bag") =>
    request(http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({
        lines: [{ description, quantity: "1", unit, unitPriceMinor: total, saved: true }],
        payments: [{ method: "cash", amountMinor: total }],
      });
  const addProduct = async (token: string, name: string, priceMinor = "500000") => {
    const created = await request(http)
      .post("/api/v1/products")
      .set(auth(token))
      .send({ name, baseUnit: "bag", priceMinor, openingQuantity: "4", openingCostMinor: "1200000" })
      .expect(201);
    return created.body.data.product.id as string;
  };
  const stock = async (productId: string) => {
    const rows = await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE product_id = $1", [productId]);
    return rows.rows[0]?.quantity;
  };

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({
        email: "owner@near.test",
        password,
        displayName: "Ada Owner",
        organizationName: "Ada Provisions",
        countryCode: "NG",
        baseCurrencyCode: "NGN",
        timezone: "Africa/Lagos",
        industryCode: "general-retail",
        acceptTerms: true,
      })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    businessId = registered.body.data.tenant.businessId as string;
    const branchId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Provisions", branchName: "Main" })
      .expect(200);
    cashier = await invite(http, owner, "girl@near.test", "CASHIER", branchId, businessId);
    other = (
      await request(http)
        .post("/api/v1/auth/register")
        .send({ email: "other@near.test", password, displayName: "Other", organizationName: "Other Shop", countryCode: "NG", acceptTerms: true })
        .expect(201)
    ).body.data.accessToken as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(other))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Other Shop", branchName: "Main" })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("sells a compact name as that product, including another name, and does not read every product", async () => {
    const ogbonoId = await addProduct(owner, "Ogbono");
    const stored = await client.query<{ compact_key: string }>("SELECT compact_key FROM products WHERE id = $1", [ogbonoId]);
    expect(stored.rows[0]?.compact_key).toBe(compactItemKey("Ogbono"));
    const index = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname = 'products_compact_key_idx'");
    expect(index.rows.map((row) => row.indexname)).toContain("products_compact_key_idx");

    const spaced = await sell(cashier, "Ogb ono").expect(201);
    expect(spaced.body.data.sale.lines[0]).toMatchObject({ productId: ogbonoId, lineKind: "product", description: "Ogbono" });
    expect(spaced.body.data.sale.lines[0].possibleProduct).toBeUndefined();
    expect(await stock(ogbonoId)).toBe("3000");

    const tenant = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM businesses WHERE id = $1", [businessId]);
    await client.query("INSERT INTO item_aliases (id, tenant_id, business_id, product_id, alias, alias_key) VALUES ($1, $2, $3, $4, 'Big rice', 'big rice')", [
      uuidv7(),
      tenant.rows[0]?.tenant_id,
      businessId,
      ogbonoId,
    ]);
    const aliasKey = await client.query<{ compact_key: string }>("SELECT compact_key FROM item_aliases WHERE product_id = $1", [ogbonoId]);
    expect(aliasKey.rows[0]?.compact_key).toBe("bigrice");
    const byAlias = await sell(cashier, "big-rice").expect(201);
    expect(byAlias.body.data.sale.lines[0]).toMatchObject({ productId: ogbonoId, lineKind: "product" });
    expect(await stock(ogbonoId)).toBe("2000");

    await client.query("UPDATE products SET name = 'Ogbono seed' WHERE id = $1", [ogbonoId]);
    const renamed = await client.query<{ compact_key: string }>("SELECT compact_key FROM products WHERE id = $1", [ogbonoId]);
    expect(renamed.rows[0]?.compact_key).toBe(compactItemKey("Ogbono seed"));
  });

  it("keeps a close spelling as typed, tells the owner, and does not take stock", async () => {
    const riceId = await addProduct(owner, "Ricebag");
    const sold = await sell(cashier, "Ricebax").expect(201);
    expect(sold.body.data.sale.lines[0]).toMatchObject({
      productId: null,
      lineKind: "quick",
      description: "Ricebax",
      possibleProduct: { id: riceId, name: "Ricebag", priceMinor: "500000" },
    });
    expect(await stock(riceId)).toBe("4000");
    const flagged = await client.query<{ action: string }>("SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'sale.typed_like_product'", [sold.body.data.sale.id]);
    expect(flagged.rows).toHaveLength(1);
    const told = await client.query<{ kind: string }>("SELECT kind FROM notifications WHERE sale_id = $1", [sold.body.data.sale.id]);
    expect(told.rows.map((row) => row.kind)).toContain("sale.typed_like_product");

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
            payload: {
              id: offlineId,
              lines: [{ description: "Ricebax", quantity: "1", unit: "bag", unitPriceMinor: "500000", saved: true }],
              payments: [{ method: "cash", amountMinor: "500000" }],
              soldAt: new Date().toISOString(),
            },
          },
        ],
      })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    const line = await client.query<{ product_id: string | null; line_kind: string; possible_product_id: string | null }>(
      "SELECT product_id, line_kind, possible_product_id FROM sale_lines WHERE sale_id = $1",
      [offlineId],
    );
    expect(line.rows[0]).toMatchObject({ product_id: null, line_kind: "quick", possible_product_id: null });
    expect(await stock(riceId)).toBe("4000");
    const offlineTold = await client.query<{ kind: string }>("SELECT kind FROM notifications WHERE sale_id = $1", [offlineId]);
    expect(offlineTold.rows.map((row) => row.kind)).toContain("sale.typed_like_product");
  });

  it("leaves a short name, two close products, an archived product and another shop alone", async () => {
    const sugarId = await addProduct(owner, "Sugar");
    const short = await sell(cashier, "Sugra").expect(201);
    expect(short.body.data.sale.lines[0]).toMatchObject({ productId: null, lineKind: "quick" });
    expect(short.body.data.sale.lines[0].possibleProduct).toBeUndefined();
    expect(await stock(sugarId)).toBe("4000");

    const firstId = await addProduct(owner, "Egusis");
    const secondId = await addProduct(owner, "Egusit");
    const both = await sell(cashier, "Egusix").expect(201);
    expect(both.body.data.sale.lines[0].productId).toBeNull();
    expect(both.body.data.sale.lines[0].possibleProduct).toBeUndefined();
    expect(await stock(firstId)).toBe("4000");
    expect(await stock(secondId)).toBe("4000");
    const notFlagged = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = 'sale.typed_like_product'", [both.body.data.sale.id]);
    expect(notFlagged.rows[0]?.n).toBe("0");

    const beansId = await addProduct(owner, "Beansack");
    await request(http).post(`/api/v1/products/${beansId}/archive`).set(auth(owner)).send({ reason: "Gone" }).expect(200);
    const archived = await sell(cashier, "Beansax").expect(201);
    expect(archived.body.data.sale.lines[0].productId).toBeNull();
    expect(archived.body.data.sale.lines[0].possibleProduct).toBeUndefined();

    const foreignId = await addProduct(other, "Millet");
    const notOurs = await sell(cashier, "Millez").expect(201);
    expect(notOurs.body.data.sale.lines[0].productId).toBeNull();
    expect(await stock(foreignId)).toBe("4000");

    const smallId = await addProduct(owner, "Peak Milk 400g", "45000");
    const largeId = await addProduct(owner, "Peak Milk 900g", "90000");
    const sized = await sell(cashier, "peakmilk400g", "45000").expect(201);
    expect(sized.body.data.sale.lines[0]).toMatchObject({ productId: smallId, lineKind: "product" });
    expect(await stock(smallId)).toBe("3000");
    expect(await stock(largeId)).toBe("4000");
  });
});

async function invite(http: Parameters<typeof request>[0], ownerToken: string, email: string, role: string, branchId: string, businessId: string) {
  const invited = await request(http).post("/api/v1/invitations").set("authorization", `Bearer ${ownerToken}`).send({ email, role, businessId, branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}
