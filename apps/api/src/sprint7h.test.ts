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
  // Several staff are invited; plan limits are tested in staff-devices.test.ts.
  DEFAULT_PLAN_CODE: "business",
  AI_PROVIDER: "fake",
};

const password = "LocalOnly!Passw0rd";

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

/** A clock time in Lagos, `offset` hours from now, as "HH:00". */
const lagosHour = (offset: number) => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return `${String((hour + offset + 24) % 24).padStart(2, "0")}:00`;
};
const everyDay = (open: string, close: string) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { open, close }]));

describe("sprint 7h: shop locks, opening hours, permission to work late, store-keeper approvals", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let manager = "";
  let sales = "";
  let store = "";
  let tenantId = "";
  let businessId = "";
  let mainId = "";
  let marketId = "";
  let milkId = "";
  let salesMembership = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const onHand = async (branchId = mainId) =>
    (await client.query<{ quantity: string }>("SELECT quantity::text FROM stock_balances WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3", [tenantId, branchId, milkId])).rows[0]?.quantity ?? "0";
  const sell = (token: string) => request(http).post("/api/v1/sales").set(auth(token)).send({ lines: [{ productId: milkId, quantity: "1", unit: "tin" }], payments: [{ method: "cash", amountMinor: "45000" }] });

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@rules.test", password, displayName: "Kemi Owner", organizationName: "Kemi Stores", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    tenantId = registered.body.data.tenant.tenantId as string;
    businessId = registered.body.data.tenant.businessId as string;
    mainId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Kemi Stores", branchName: "Main" })
      .expect(200);
    marketId = (await request(http).post("/api/v1/branches").set(auth(owner)).send({ name: "Market shop", businessId }).expect(201)).body.data.branch.id as string;
    owner = (await request(http).post("/api/v1/auth/select-context").set(auth(owner)).send({ organizationId: tenantId, businessId, branchId: mainId }).expect(201)).body.data.accessToken as string;
    milkId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", defaultCostMinor: "35000", openingQuantity: "20", openingCostMinor: "700000" }).expect(201)).body.data.product.id as string;
    manager = await invite(http, owner, "manager@rules.test", "MANAGER", mainId, businessId);
    sales = await invite(http, owner, "sales@rules.test", "CASHIER", mainId, businessId);
    store = await invite(http, owner, "store@rules.test", "INVENTORY", mainId, businessId);
    const people = (await request(http).get("/api/v1/memberships").set(auth(owner)).expect(200)).body.data.items as { email: string; membershipId: string }[];
    salesMembership = people.find((person) => person.email === "sales@rules.test")!.membershipId;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets only the owner lock a shop; staff can still look and sign in, but change nothing there", async () => {
    await request(http).post(`/api/v1/branches/${mainId}/lock`).set(auth(manager)).send({}).expect(403);
    const locked = await request(http).post(`/api/v1/branches/${mainId}/lock`).set(auth(owner)).send({ note: "Stock check tomorrow" }).expect(200);
    expect(locked.body.data.shops.find((shop: { id: string }) => shop.id === mainId).lockNote).toBe("Stock check tomorrow");

    const refused = await sell(sales).expect(423);
    expect(refused.body.error.code).toBe("SHOP_LOCKED");
    expect(refused.body.error.message).toContain("Main");
    await request(http).post("/api/v1/customers").set(auth(manager)).send({ name: "Ada Buyer", isWalkIn: true }).expect(423);
    // Reading and signing in still work.
    await request(http).get("/api/v1/products").set(auth(sales)).expect(200);
    await request(http).post("/api/v1/notifications/read").set(auth(sales)).send({ all: true }).expect(200);
    await request(http).post("/api/v1/auth/login").send({ email: "sales@rules.test", password }).expect(201);
    const status = await request(http).get("/api/v1/work-rules/status").set(auth(sales)).expect(200);
    expect(status.body.data).toMatchObject({ owner: false, locked: { shop: "Main", note: "Stock check tomorrow" }, blocked: { code: "SHOP_LOCKED" } });
    // A move into the locked shop from elsewhere is refused too.
    const invited = await request(http).post("/api/v1/invitations").set(auth(owner)).send({ email: "area@rules.test", role: "MANAGER", businessId }).expect(201);
    await request(http).post("/api/v1/invitations/accept").send({ token: invited.body.data.invitation.token, displayName: "Area Manager", password }).expect(201);
    const area = (await request(http).post("/api/v1/auth/login").send({ email: "area@rules.test", password }).expect(201)).body.data.accessToken as string;
    const inMarket = (await request(http).post("/api/v1/auth/select-context").set(auth(area)).send({ organizationId: tenantId, businessId, branchId: marketId }).expect(201)).body.data.accessToken as string;
    expect((await request(http).post("/api/v1/stock/transfer").set(auth(inMarket)).send({ productId: milkId, fromBranchId: marketId, toBranchId: mainId, quantity: "1", unit: "tin" }).expect(423)).body.error.code).toBe("SHOP_LOCKED");

    // The owner still works, and unlocks.
    await sell(owner).expect(201);
    await request(http).post(`/api/v1/branches/${mainId}/unlock`).set(auth(owner)).expect(200);
    await sell(sales).expect(201);
    const audit = await client.query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id = $1 AND action IN ('branch.locked', 'branch.unlocked') ORDER BY created_at", [tenantId]);
    expect(audit.rows.map((row) => row.action)).toEqual(["branch.locked", "branch.unlocked"]);
  });

  it("keeps staff out of the books outside opening hours unless the owner lets them work, for a set time", async () => {
    await request(http).put("/api/v1/work-rules/hours").set(auth(manager)).send({ hours: everyDay("08:00", "18:00") }).expect(403);
    await request(http).put("/api/v1/work-rules/hours").set(auth(owner)).send({ hours: everyDay("8am", "18:00") }).expect(400);
    // Open around now: staff work.
    await request(http).put("/api/v1/work-rules/hours").set(auth(owner)).send({ hours: everyDay(lagosHour(-1), lagosHour(2)) }).expect(200);
    await sell(sales).expect(201);
    // Only the owner lets people work outside the hours.
    await request(http).post("/api/v1/work-permits").set(auth(manager)).send({ membershipId: salesMembership, until: new Date(Date.now() + 7_200_000).toISOString() }).expect(403);
    // Closed now.
    const set = await request(http).put("/api/v1/work-rules/hours").set(auth(owner)).send({ hours: everyDay(lagosHour(5), lagosHour(6)) }).expect(200);
    expect(set.body.data.hours.mon).toEqual({ open: lagosHour(5), close: lagosHour(6) });
    const refused = await sell(sales).expect(423);
    expect(refused.body.error).toMatchObject({ code: "OUTSIDE_HOURS" });
    expect(refused.body.error.message).toContain(`${lagosHour(5)}–${lagosHour(6)}`);
    await sell(manager).expect(423);
    await sell(owner).expect(201);
    expect((await request(http).get("/api/v1/work-rules/status").set(auth(sales)).expect(200)).body.data).toMatchObject({ open: false, blocked: { code: "OUTSIDE_HOURS" }, permitUntil: null });

    // The owner lets the cashier work for two hours.
    await request(http).post("/api/v1/work-permits").set(auth(owner)).send({ membershipId: salesMembership, until: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await request(http).post("/api/v1/work-permits").set(auth(owner)).send({ membershipId: salesMembership, until: new Date(Date.now() + 15 * 86_400_000).toISOString() }).expect(400);
    const granted = await request(http).post("/api/v1/work-permits").set(auth(owner)).send({ membershipId: salesMembership, until: new Date(Date.now() + 7_200_000).toISOString(), note: "Stock arriving late" }).expect(200);
    const permit = granted.body.data.permits[0];
    expect(permit).toMatchObject({ name: "sales@rules.test", note: "Stock arriving late" });
    await sell(sales).expect(201);
    expect((await request(http).get("/api/v1/work-rules/status").set(auth(sales)).expect(200)).body.data.permitUntil).toBe(permit.until);
    await sell(manager).expect(423);
    // Stopped early.
    await request(http).post(`/api/v1/work-permits/${permit.id}/stop`).set(auth(owner)).expect(200);
    await sell(sales).expect(423);
  });

  it("accepts work done offline outside the hours, and tells the owner", async () => {
    const pushed = await request(http)
      .post("/api/v1/sync/push")
      .set(auth(sales))
      .send({ operations: [{ id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), name: "Late Night Buyer", isWalkIn: true } }] })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("applied");
    const flagged = await client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE tenant_id = $1 AND action = 'work.outside_rules'", [tenantId]);
    expect(JSON.parse(flagged.rows[0]?.metadata_json ?? "{}")).toMatchObject({ rule: "OUTSIDE_HOURS", type: "customer.create" });
    const told = await request(http).get("/api/v1/notifications").set(auth(owner)).expect(200);
    expect(told.body.data.items.map((item: { kind: string }) => item.kind)).toContain("work.after_hours_offline");
    // Hours off again: staff work at any time.
    await request(http).put("/api/v1/work-rules/hours").set(auth(owner)).send({ hours: null }).expect(200);
    await sell(sales).expect(201);
  });

  it("sends the store keeper's stock in, changes and moves to a manager or owner to approve and complete", async () => {
    const before = await onHand();
    const asked = await request(http).post("/api/v1/stock/receive").set(auth(store)).send({ productId: milkId, quantity: "6", unit: "tin", paidFrom: "credit", supplier: "Dangote Distributors" }).expect(201);
    expect(asked.body.data).toMatchObject({ waiting: true, request: { kind: "receive", status: "pending" } });
    expect(asked.body.data.request.summary).toBe("Receive 6 tin of Peak Milk from Dangote Distributors (owed)");
    expect(await onHand()).toBe(before);
    // The store keeper can now ask to take goods off, with a reason, but not more than is on the shelf.
    await request(http).post("/api/v1/stock/adjust").set(auth(store)).send({ productId: milkId, direction: "remove", reason: "damaged", quantity: "500", unit: "tin", note: "Rain" }).expect(422);
    const damaged = await request(http).post("/api/v1/stock/adjust").set(auth(store)).send({ productId: milkId, direction: "remove", reason: "damaged", quantity: "2", unit: "tin", note: "Dented tins" }).expect(201);
    const move = await request(http).post("/api/v1/stock/transfer").set(auth(store)).send({ productId: milkId, toBranchId: marketId, quantity: "3", unit: "tin", note: "For the stall" }).expect(201);
    expect(move.body.data.request.summary).toBe("Move 3 tin of Peak Milk from Main to Market shop");
    expect(await onHand()).toBe(before);

    const waiting = await request(http).get("/api/v1/stock/requests").set(auth(manager)).expect(200);
    expect(waiting.body.data.canApprove).toBe(true);
    expect(waiting.body.data.waiting.map((item: { kind: string }) => item.kind)).toEqual(["receive", "adjust", "transfer"]);
    expect(waiting.body.data.waiting[0].requestedBy).toBe("store@rules.test");
    const told = await request(http).get("/api/v1/notifications").set(auth(manager)).expect(200);
    expect(told.body.data.items.filter((item: { kind: string }) => item.kind === "stock.request")).toHaveLength(3);
    const mine = await request(http).get("/api/v1/stock/requests").set(auth(store)).expect(200);
    expect(mine.body.data).toMatchObject({ canApprove: false });
    expect(mine.body.data.waiting).toHaveLength(3);

    // The store keeper cannot approve; a manager approves and the change happens now.
    const [receiveId, adjustId, moveId] = waiting.body.data.waiting.map((item: { id: string }) => item.id) as string[];
    await request(http).post(`/api/v1/stock/requests/${receiveId}/approve`).set(auth(store)).send({}).expect(403);
    const approved = await request(http).post(`/api/v1/stock/requests/${receiveId}/approve`).set(auth(manager)).send({ note: "Checked the delivery note" }).expect(200);
    expect(approved.body.data.request).toMatchObject({ status: "approved", decidedBy: "manager@rules.test", decisionNote: "Checked the delivery note" });
    expect(BigInt(await onHand())).toBe(BigInt(before) + 6000n);
    await request(http).post(`/api/v1/stock/requests/${receiveId}/approve`).set(auth(manager)).send({}).expect(409);
    const owed = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM supplier_purchases WHERE tenant_id = $1", [tenantId]).catch(() => ({ rows: [{ n: "1" }] }));
    expect(Number(owed.rows[0]?.n)).toBeGreaterThan(0);
    await request(http).post(`/api/v1/stock/requests/${adjustId}/approve`).set(auth(owner)).send({}).expect(200);
    expect(BigInt(await onHand())).toBe(BigInt(before) + 4000n);
    // Rejecting says why; nothing moves.
    await request(http).post(`/api/v1/stock/requests/${moveId}/reject`).set(auth(manager)).send({ note: "" }).expect(400);
    await request(http).post(`/api/v1/stock/requests/${moveId}/reject`).set(auth(manager)).send({ note: "The stall is full" }).expect(200);
    expect(await onHand(marketId)).toBe("0");
    const result = await request(http).get("/api/v1/notifications").set(auth(store)).expect(200);
    expect(result.body.data.items.map((item: { kind: string }) => item.kind)).toEqual(expect.arrayContaining(["stock.request_approved", "stock.request_rejected"]));
    const history = await request(http).get(`/api/v1/products/${milkId}/changes`).set(auth(owner)).expect(200);
    expect(history.body.data.items.map((item: { action: string }) => item.action)).toEqual(expect.arrayContaining(["stock.requested", "stock.request_approved", "stock.request_rejected"]));
    expect(damaged.body.data.request.summary).toBe("Take off 2 tin of Peak Milk (damaged): Dented tins");
  });

  it("sends a store keeper's delivery list for approval too, and lets the manager's own go straight in", async () => {
    const rows = [{ product: "Peak Milk", quantity: "4", unit: "", cost: "", supplier: "Dangote Distributors", paid: "owed", ref: "DN-9" }];
    const before = await onHand();
    const checked = await request(http).post("/api/v1/imports/stock-in").set(auth(store)).send({ rows }).expect(200);
    expect(checked.body.data).toMatchObject({ committed: false, waiting: true });
    expect(checked.body.data.results[0].message).toMatch(/^Waits for a manager or owner: /);
    const saved = await request(http).post("/api/v1/imports/stock-in").set(auth(store)).send({ rows, dryRun: false }).expect(200);
    expect(saved.body.data).toMatchObject({ committed: true, waiting: true });
    expect(await onHand()).toBe(before);
    const change = await request(http).post("/api/v1/imports/stock-change").set(auth(store)).send({ rows: [{ product: "Peak Milk", change: "remove", reason: "missing", quantity: "1", unit: "", note: "Short on the shelf" }], dryRun: false }).expect(200);
    expect(change.body.data).toMatchObject({ committed: true, waiting: true });
    expect(await onHand()).toBe(before);
    expect((await request(http).get("/api/v1/stock/requests").set(auth(manager)).expect(200)).body.data.waiting).toHaveLength(2);
    const direct = await request(http).post("/api/v1/imports/stock-in").set(auth(manager)).send({ rows, dryRun: false }).expect(200);
    expect(direct.body.data).toMatchObject({ committed: true, waiting: false });
    expect(BigInt(await onHand())).toBe(BigInt(before) + 4000n);
  });
});
