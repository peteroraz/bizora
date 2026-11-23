import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { expect } from "vitest";
import { createApp } from "./bootstrap.js";
import { schema } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";
import type { ConsoleEmailAdapter } from "./modules/email/console-email.adapter.js";
import { EMAIL } from "./tokens.js";

/** Shared set-up for the pilot readiness suites (ADR-042): one app on an in-memory Postgres, owners and staff. */
export const password = "LocalOnly!Passw0rd";

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
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
    THROTTLE_AUTH_LIMIT: 500,
    INVITE_TOKEN_EXPOSE: true,
    TRUST_PROXY: false,
    DEFAULT_PLAN_CODE: "business",
    AI_PROVIDER: "fake",
    ...overrides,
  };
}

export type Harness = {
  app: INestApplication;
  http: Parameters<typeof request>[0];
  client: PGlite;
  db: ReturnType<typeof drizzle<typeof schema>>;
  email: ConsoleEmailAdapter;
  close: () => Promise<void>;
};

export async function boot(env: AppEnv = testEnv()): Promise<Harness> {
  const client = new PGlite();
  for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
  const db = drizzle(client, { schema });
  const app = await createApp(env, db as never, createLogger("error"));
  await app.init();
  return {
    app,
    http: app.getHttpServer(),
    client,
    db,
    email: app.get(EMAIL) as ConsoleEmailAdapter,
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export type Shop = { token: string; tenantId: string; businessId: string; branchId: string; userId: string; email: string };

/** A new business with its owner signed in, set up as a Nigerian shop. */
export async function shop(http: Harness["http"], email: string, name: string): Promise<Shop> {
  const registered = await request(http)
    .post("/api/v1/auth/register")
    .send({ email, password, displayName: `${name} Owner`, organizationName: name, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true })
    .expect(201);
  const token = registered.body.data.accessToken as string;
  await request(http)
    .patch("/api/v1/onboarding")
    .set(auth(token))
    .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: name, branchName: "Main" })
    .expect(200);
  const tenant = registered.body.data.tenant as { tenantId: string; businessId: string; branchId: string };
  return { token, tenantId: tenant.tenantId, businessId: tenant.businessId, branchId: tenant.branchId, userId: registered.body.data.user.id as string, email };
}

/** Invites someone into the shop with a role, accepts, and signs them in. */
export async function staff(http: Harness["http"], owner: Shop, email: string, role: string) {
  const invited = await request(http).post("/api/v1/invitations").set(auth(owner.token)).send({ email, role, businessId: owner.businessId, branchId: owner.branchId }).expect(201);
  await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: email, password }).expect(201);
  const login = await request(http).post("/api/v1/auth/login").send({ email, password }).expect(201);
  return login.body.data.accessToken as string;
}

/** A product with opening stock (quantities in thousandths, money in minor units). */
export async function product(http: Harness["http"], token: string, name: string, priceMinor: string, opening = "10", unit = "bag") {
  const created = await request(http).post("/api/v1/products").set(auth(token)).send({ name, baseUnit: unit, priceMinor, openingQuantity: opening, openingCostMinor: (BigInt(priceMinor) * 8n / 10n * BigInt(Number(opening) || 0)).toString() }).expect(201);
  return created.body.data.product.id as string;
}

export async function customer(http: Harness["http"], token: string, name: string, phone: string, creditAllowed = true) {
  const created = await request(http).post("/api/v1/customers").set(auth(token)).send({ name, phone, creditAllowed }).expect(201);
  return created.body.data.customer.id as string;
}

/** Every journal entry in the books balances: debits equal credits, entry by entry and overall. */
export async function expectBalancedBooks(client: PGlite, tenantId: string) {
  const unbalanced = await client.query<{ entry_id: string; debit: string; credit: string }>(
    `SELECT jl.entry_id, sum(jl.debit_minor)::text AS debit, sum(jl.credit_minor)::text AS credit
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.tenant_id = $1 GROUP BY jl.entry_id HAVING sum(jl.debit_minor) <> sum(jl.credit_minor)`,
    [tenantId],
  );
  expect(unbalanced.rows).toEqual([]);
}
