import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { uuidv7 } from "@bizora/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { DocumentNumberService } from "./modules/documents/document-number.service.js";
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

describe("offline sync foundation", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let salesToken = "";
  let cashierToken = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    salesToken = await invite(http, a.token, "sales@offline.test", "SALES", a.branchId, a.businessId);
    // A store keeper may not add customers (cashiers may, at the counter: ADR-019).
    cashierToken = await invite(http, a.token, "store@offline.test", "INVENTORY", a.branchId, a.businessId);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const countCustomers = async (tenantId: string) =>
    Number((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1", [tenantId])).rows[0]?.n);

  it("returns the first result when a customer create is retried with the same key", async () => {
    const http = app.getHttpServer();
    const key = uuidv7();
    const body = { name: "Retry Ade", phone: "08030000001" };
    const first = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", key).send(body).expect(201);
    const before = await countCustomers(a.tenantId);
    const second = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", key).send(body).expect(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.data.customer.id).toBe(first.body.data.customer.id);
    expect(await countCustomers(a.tenantId)).toBe(before);

    // Same key, different request: refused. Another person in the same shop: refused too.
    const reused = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", key).send({ ...body, name: "Other" }).expect(422);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const otherPerson = await request(http).post("/api/v1/customers").set(auth(salesToken)).set("idempotency-key", key).send(body).expect(422);
    expect(otherPerson.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // Keys belong to one organization: the other shop can use the same key for its own customer.
    const otherShop = await request(http).post("/api/v1/customers").set(auth(b.token)).set("idempotency-key", key).send(body).expect(201);
    expect(otherShop.headers["idempotent-replayed"]).toBeUndefined();
    expect(otherShop.body.data.customer.id).not.toBe(first.body.data.customer.id);

    const bad = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", "short").send(body).expect(400);
    expect(bad.body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("remembers a refusal, so a retry is refused the same way", async () => {
    const http = app.getHttpServer();
    const key = uuidv7();
    const duplicatePhone = { name: "Second Ade", phone: "08030000001" };
    const first = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", key).send(duplicatePhone);
    expect(first.status).toBe(409);
    const again = await request(http).post("/api/v1/customers").set(auth(a.token)).set("idempotency-key", key).send(duplicatePhone);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(first.body.error.code);
  });

  it("keeps the ID a device chose, and never reuses another shop's ID", async () => {
    const http = app.getHttpServer();
    const id = uuidv7();
    const created = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ id, name: "Device Ngozi", isWalkIn: true }).expect(201);
    expect(created.body.data.customer.id).toBe(id);
    const notV7 = await request(http)
      .post("/api/v1/customers")
      .set(auth(a.token))
      .send({ id: "8f0d9c5e-0d7f-4c55-9d3f-2a4b6e7c8d90", name: "Bad", isWalkIn: true })
      .expect(400);
    expect(notV7.body.error.code).toBe("VALIDATION_ERROR");
    // The same shop sending the same new customer again (a lost response) gets the same customer back.
    const resent = await request(http).post("/api/v1/customers").set(auth(a.token)).send({ id, name: "Device Ngozi", isWalkIn: true }).expect(201);
    expect(resent.body.data.customer.id).toBe(id);
    const withPhone = uuidv7();
    await request(http).post("/api/v1/customers").set(auth(a.token)).send({ id: withPhone, name: "Phone Ngozi", phone: "08037770001" }).expect(201);
    await request(http).post("/api/v1/customers").set(auth(a.token)).send({ id: withPhone, name: "Phone Ngozi", phone: "08037770001" }).expect(201);
    const stolen = await request(http).post("/api/v1/customers").set(auth(b.token)).send({ id, name: "Other shop", isWalkIn: true }).expect(409);
    expect(stolen.body.error.code).toBe("ID_CONFLICT");
    expect(stolen.body.error.message).not.toContain("Shop a");
  });

  it("applies queued operations once, in order, and reports each one", async () => {
    const http = app.getHttpServer();
    const ops = [
      { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), name: "Offline Bisi", phone: "08031110001" } },
      { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), name: "Offline Tunde", isWalkIn: true } },
      { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), phone: "080" } },
      { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), name: "Offline Same Phone", phone: "08031110001" } },
    ];
    const pushed = await request(http).post("/api/v1/sync/push").set(auth(a.token)).send({ operations: ops }).expect(200);
    const results = pushed.body.data.results as { id: string; status: string; result?: { customer: { id: string } }; error?: { code: string } }[];
    expect(results.map((result) => result.status)).toEqual(["applied", "applied", "rejected", "rejected"]);
    expect(results[0]?.result?.customer.id).toBe((ops[0]?.payload as { id: string }).id);
    expect(results[2]?.error?.code).toBe("VALIDATION_ERROR");
    expect(results[3]?.error?.code).toBe("DUPLICATE_PHONE");

    // The device did not hear back and sends everything again: nothing is created twice.
    const before = await countCustomers(a.tenantId);
    const again = await request(http).post("/api/v1/sync/push").set(auth(a.token)).send({ operations: ops }).expect(200);
    expect(again.body.data.results.map((result: { status: string }) => result.status)).toEqual(["duplicate", "duplicate", "rejected", "rejected"]);
    expect(again.body.data.results[0].result.customer.id).toBe(results[0]?.result?.customer.id);
    expect(await countCustomers(a.tenantId)).toBe(before);
  });

  it("checks permissions and organization for every queued operation", async () => {
    const http = app.getHttpServer();
    const op = () => ({ id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), name: "Queued", isWalkIn: true } });
    const cashier = await request(http).post("/api/v1/sync/push").set(auth(cashierToken)).send({ operations: [op()] }).expect(200);
    expect(cashier.body.data.results[0]).toMatchObject({ status: "rejected", error: { code: "FORBIDDEN" } });
    const sales = await request(http).post("/api/v1/sync/push").set(auth(salesToken)).send({ operations: [op()] }).expect(200);
    expect(sales.body.data.results[0].status).toBe("applied");

    // Another shop replays shop A's operation and customer IDs: it gets its own operation, and the ID is refused.
    const aOp = op();
    await request(http).post("/api/v1/sync/push").set(auth(a.token)).send({ operations: [aOp] }).expect(200);
    const replayed = await request(http).post("/api/v1/sync/push").set(auth(b.token)).send({ operations: [aOp] }).expect(200);
    expect(replayed.body.data.results[0]).toMatchObject({ status: "rejected", error: { code: "ID_CONFLICT" } });
    const [row] = (await client.query<{ tenant_id: string }>("SELECT tenant_id FROM customers WHERE id = $1", [(aOp.payload as { id: string }).id])).rows;
    expect(row?.tenant_id).toBe(a.tenantId);

    await request(http).post("/api/v1/sync/push").send({ operations: [op()] }).expect(401);
    await request(http)
      .post("/api/v1/sync/push")
      .set(auth(a.token))
      .send({ operations: Array.from({ length: 51 }, op) })
      .expect(400);
  });

  it("numbers shop devices per organization", async () => {
    const http = app.getHttpServer();
    const first = await request(http).post("/api/v1/shop-devices").set(auth(a.token)).send({ name: "Counter" }).expect(201);
    const second = await request(http).post("/api/v1/shop-devices").set(auth(a.token)).send({ name: "Back room" }).expect(201);
    const other = await request(http).post("/api/v1/shop-devices").set(auth(b.token)).send({ name: "Counter" }).expect(201);
    expect([first.body.data.device.code, second.body.data.device.code, other.body.data.device.code]).toEqual([1, 2, 1]);
  });

  it("issues official document numbers in order, per business and type", async () => {
    const numbers = app.get(DocumentNumberService);
    const issued = [];
    for (let index = 0; index < 3; index += 1) issued.push((await numbers.next(db, a.tenantId, a.businessId, "receipt")).number);
    expect(issued).toEqual(["R-000001", "R-000002", "R-000003"]);
    expect((await numbers.next(db, a.tenantId, a.businessId, "invoice")).number).toBe("INV-000001");
    expect((await numbers.next(db, b.tenantId, b.businessId, "receipt")).number).toBe("R-000001");
    // A number taken inside a transaction that fails is not used up.
    await expect(
      db.transaction(async (tx) => {
        await numbers.next(tx, a.tenantId, a.businessId, "receipt");
        throw new Error("sale failed");
      }),
    ).rejects.toThrow("sale failed");
    expect((await numbers.next(db, a.tenantId, a.businessId, "receipt")).number).toBe("R-000004");
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
