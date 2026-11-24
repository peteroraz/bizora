import "reflect-metadata";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const relabel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../drizzle/0046_old_typed_lines.sql"), "utf8");

describe("units, old typed lines, and a cash-out above the drawer (ADR-053)", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let accountant = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sell = (token: string, lines: unknown[], total: string) =>
    request(http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({ lines, payments: [{ method: "cash", amountMinor: total }] });
  const codes = async () => {
    const units = (await request(http).get("/api/v1/units").set(auth(owner)).expect(200)).body.data.units as { id?: string; code: string }[];
    return units;
  };

  beforeAll(async () => {
    client = new PGlite();
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, drizzle(client, { schema }), createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@units.test", password, displayName: "Ada Owner", organizationName: "Ada Provisions", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    const tenant = registered.body.data.tenant as { businessId: string; branchId: string };
    await request(http).patch("/api/v1/onboarding").set(auth(owner)).send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Provisions", branchName: "Main" }).expect(200);
    cashier = await invite(http, owner, "girl@units.test", "CASHIER", tenant.branchId, tenant.businessId);
    accountant = await invite(http, owner, "books@units.test", "ACCOUNTANT", tenant.branchId, tenant.businessId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("keeps a typed unit off the list until a second sale, and saves one the owner adds", async () => {
    const added = await request(http).post("/api/v1/units").set(auth(owner)).send({ code: "keg", displayName: "Keg" }).expect(201);
    const kegId = added.body.data.unit.id as string;
    expect((await codes()).map((unit) => unit.code)).toContain("keg");

    await sell(
      cashier,
      [
        { description: "Pepper", quantity: "1", unit: "mudu", unitPriceMinor: "100000", saved: true },
        { description: "Salt", quantity: "1", unit: "mudu", unitPriceMinor: "50000", saved: true },
      ],
      "150000",
    ).expect(201);
    expect((await codes()).map((unit) => unit.code)).not.toContain("mudu");

    await sell(cashier, [{ description: "Pepper", quantity: "1", unit: "mudu", unitPriceMinor: "100000", saved: true }], "100000").expect(201);
    const after = await codes();
    expect(after.map((unit) => unit.code)).toContain("mudu");
    const muduId = after.find((unit) => unit.code === "mudu")?.id as string;

    await request(http).patch(`/api/v1/units/${kegId}`).set(auth(owner)).send({ active: false }).expect(200);
    expect((await codes()).map((unit) => unit.code)).not.toContain("keg");
    await request(http).post("/api/v1/units").set(auth(owner)).send({ code: "keg", displayName: "Keg" }).expect(201);
    expect((await codes()).map((unit) => unit.code)).toContain("keg");

    const refused = await request(http).patch(`/api/v1/units/${muduId}`).set(auth(owner)).send({ active: false }).expect(409);
    expect(refused.body.error.message).toBe("This unit is on a sale, so it stays in the list.");
    expect((await codes()).map((unit) => unit.code)).toContain("mudu");
  });

  it("relabels typed goods that were marked service, and leaves job bills and real services", async () => {
    const typed = await sell(cashier, [{ description: "Crayfish", quantity: "1", unit: "bag", unitPriceMinor: "200000", saved: true }], "200000").expect(201);
    const typedId = typed.body.data.sale.id as string;
    const typedCredits = await client.query<{ role: string }>(
      `SELECT a.role FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id WHERE je.source_id = $1 AND jl.credit_minor > 0`,
      [typedId],
    );
    expect(typedCredits.rows.map((row) => row.role)).not.toContain("service_income");

    const service = await sell(cashier, [{ description: "Haircut", quantity: "1", unit: "piece", unitPriceMinor: "500000" }], "500000").expect(201);
    const serviceId = service.body.data.sale.id as string;
    expect(service.body.data.sale.lines[0].lineKind).toBe("service");
    const serviceCredits = await client.query<{ role: string }>(
      `SELECT a.role FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id WHERE je.source_id = $1 AND jl.credit_minor > 0`,
      [serviceId],
    );
    expect(serviceCredits.rows.map((row) => row.role)).toContain("service_income");

    await client.query(`UPDATE sale_lines SET line_kind = 'service' WHERE sale_id = $1`, [typedId]);
    const jobId = uuidv7();
    const importId = uuidv7();
    const quietId = uuidv7();
    const copySale = (id: string, source: string, historyOnly: boolean, journal: "keep" | "none") =>
      client.query(
        `INSERT INTO sales (id, tenant_id, business_id, branch_id, sale_number, status, history_only, source, currency_code, subtotal_minor, discount_minor, total_minor, paid_minor, balance_minor, receipt_token, journal_entry_id, sold_at, released_at, collected_at)
         SELECT $1, tenant_id, business_id, branch_id, $2, 'completed', $3, $4, currency_code, subtotal_minor, discount_minor, total_minor, paid_minor, balance_minor, $5, ${journal === "keep" ? "journal_entry_id" : "NULL"}, sold_at, released_at, collected_at FROM sales WHERE id = $6`,
        [id, id.replace(/-/g, "").slice(0, 24), historyOnly, source, `token-${id}`, typedId],
      );
    await copySale(jobId, "job", false, "keep");
    await copySale(importId, "import", true, "keep");
    await copySale(quietId, "pos", false, "none");
    for (const saleId of [jobId, importId, quietId]) {
      await client.query(
        `INSERT INTO sale_lines (id, tenant_id, business_id, sale_id, line_no, description, quantity, entered_quantity, entered_unit, unit_price_minor, line_total_minor, line_kind)
         SELECT $1, tenant_id, business_id, $2, 1, description, quantity, entered_quantity, entered_unit, unit_price_minor, line_total_minor, 'service' FROM sale_lines WHERE sale_id = $3 LIMIT 1`,
        [uuidv7(), saleId, typedId],
      );
    }

    await client.exec(relabel);

    const kinds = await client.query<{ sale_id: string; line_kind: string }>(
      `SELECT sale_id, line_kind FROM sale_lines WHERE sale_id IN ($1, $2, $3, $4, $5)`,
      [typedId, serviceId, jobId, importId, quietId],
    );
    const kindOf = (id: string) => kinds.rows.find((row) => row.sale_id === id)?.line_kind;
    expect(kindOf(typedId)).toBe("quick");
    expect(kindOf(serviceId)).toBe("service");
    expect(kindOf(jobId)).toBe("service");
    expect(kindOf(importId)).toBe("service");
    expect(kindOf(quietId)).toBe("service");
  });

  it("tells the counter what the drawer should hold, and still records a larger cash-out", async () => {
    await request(http).get("/api/v1/money/drawer-expected").set(auth(accountant)).expect(403);
    const before = BigInt((await request(http).get("/api/v1/money/drawer-expected").set(auth(cashier)).expect(200)).body.data.expectedMinor as string);
    await sell(cashier, [{ description: "Garri", quantity: "1", unit: "bag", unitPriceMinor: "300000", saved: true }], "300000").expect(201);
    const after = BigInt((await request(http).get("/api/v1/money/drawer-expected").set(auth(cashier)).expect(200)).body.data.expectedMinor as string);
    expect(after - before).toBe(300000n);

    const saved = await request(http)
      .post("/api/v1/money/pos-cashouts")
      .set(auth(cashier))
      .send({ amountMinor: (after + 100000n).toString(), feeMinor: "0", feePaidBy: "pos" })
      .expect(201);
    expect(saved.body.data.movement.amountMinor).toBe((after + 100000n).toString());
    const left = BigInt((await request(http).get("/api/v1/money/drawer-expected").set(auth(cashier)).expect(200)).body.data.expectedMinor as string);
    expect(left).toBe(-100000n);
  });
});

async function invite(http: Parameters<typeof request>[0], ownerToken: string, email: string, role: string, branchId: string, businessId: string) {
  const invited = await request(http).post("/api/v1/invitations").set("authorization", `Bearer ${ownerToken}`).send({ email, role, businessId, branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}
