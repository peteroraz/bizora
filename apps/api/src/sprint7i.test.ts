import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
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

const lagosDay = (offset = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date(Date.now() + offset * 86_400_000));

describe("sprint 7i: jobs for service businesses, lines without a product, deposits", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Parameters<typeof request>[0];
  let owner = "";
  let cashier = "";
  let desk = "";
  let tenantId = "";
  let businessId = "";
  let mainId = "";
  let discId = "";
  let jobId = "";
  let customerId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  /** Each account's balance (debits minus credits) by code. */
  const books = async () => {
    const rows = await client.query<{ code: string; balance: string }>(
      "SELECT a.code, (sum(l.debit_minor) - sum(l.credit_minor))::text AS balance FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.tenant_id = $1 GROUP BY a.code",
      [tenantId],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.code, BigInt(row.balance)])) as Record<string, bigint>;
  };
  const onHand = async (productId: string) =>
    BigInt((await client.query<{ q: string }>("SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE tenant_id = $1 AND product_id = $2", [tenantId, productId])).rows[0]?.q ?? "0");

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) await client.exec(migration.sql);
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    const registered = await request(http)
      .post("/api/v1/auth/register")
      .send({ email: "owner@jobs.test", password, displayName: "Emeka Owner", organizationName: "Emeka Motors", countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" })
      .expect(201);
    owner = registered.body.data.accessToken as string;
    tenantId = registered.body.data.tenant.tenantId as string;
    businessId = registered.body.data.tenant.businessId as string;
    mainId = registered.body.data.tenant.branchId as string;
    await request(http)
      .patch("/api/v1/onboarding")
      .set(auth(owner))
      .send({ countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Emeka Motors", branchName: "Workshop" })
      .expect(200);
    discId = (await request(http).post("/api/v1/products").set(auth(owner)).send({ name: "Brake disc", baseUnit: "piece", priceMinor: "2000000", openingQuantity: "5", openingCostMinor: "6000000" }).expect(201)).body.data.product.id as string;
    cashier = await invite(http, owner, "cashier@jobs.test", "CASHIER", mainId, businessId);
    desk = await invite(http, owner, "desk@jobs.test", "SALES", mainId, businessId);
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("opens a job for a new customer from yesterday: work, a part from stock, a part bought, a helper and a deposit", async () => {
    const opened = await request(http)
      .post("/api/v1/jobs")
      .set(auth(cashier))
      .send({
        customer: { name: "Mr Okeke", phone: "0803 123 4567" },
        title: "Toyota Camry, LND 123 AB",
        problem: "Brakes making noise",
        summary: "Brake pads changed, engine oil bought. Deposit of 10,000 paid.",
        day: lagosDay(-1),
        lines: [
          { kind: "work", description: "Brake pad replacement", unitPriceMinor: "1500000", save: true },
          { kind: "part", productId: discId, quantity: "1", unit: "piece" },
          { kind: "bought", description: "Engine oil", quantity: "4", unit: "litre", costMinor: "1200000", paidFrom: "cash" },
          { kind: "helper", description: "Vulcaniser", costMinor: "200000", paidFrom: "cash" },
        ],
        payment: { method: "cash", amountMinor: "1000000" },
      })
      .expect(201);
    const view = opened.body.data;
    jobId = view.job.id;
    customerId = view.customer.id;
    expect(view.job).toMatchObject({ number: "JOB-000001", status: "open", openedOn: lagosDay(-1), title: "Toyota Camry, LND 123 AB" });
    expect(view.customer).toMatchObject({ name: "Mr Okeke", phone: "+2348031234567" });
    expect(view.totals).toMatchObject({ chargedMinor: "4700000", depositsMinor: "1000000", leftMinor: "3700000" });
    expect(view.lines.map((line: { kind: string; totalMinor: string }) => [line.kind, line.totalMinor])).toEqual([
      ["work", "1500000"],
      ["part", "2000000"],
      ["bought", "1200000"],
      ["helper", "0"],
    ]);
    // The cashier cannot see what parts from stock cost, or the profit.
    expect(view.lines[1]).not.toHaveProperty("costMinor");
    expect(view.totals).not.toHaveProperty("profitMinor");

    // The regular job is saved; the oil is now a product with its last cost; stock is right.
    const regulars = await request(http).get("/api/v1/jobs/regulars").set(auth(cashier)).expect(200);
    expect(regulars.body.data.items).toEqual([expect.objectContaining({ name: "Brake pad replacement", priceMinor: "1500000" })]);
    const oil = await client.query<{ id: string; default_cost_minor: string; track_stock: boolean }>("SELECT id, default_cost_minor::text, track_stock FROM products WHERE tenant_id = $1 AND name = 'Engine oil'", [tenantId]);
    expect(oil.rows[0]).toMatchObject({ default_cost_minor: "300000", track_stock: true });
    expect(await onHand(oil.rows[0]!.id)).toBe(0n);
    expect(await onHand(discId)).toBe(4000n);

    // The books: parts and the helper wait in Jobs in progress; the deposit is held for the customer.
    const ledger = await books();
    expect(ledger["1350"]).toBe(1200000n + 1200000n + 200000n);
    expect(ledger["2100"]).toBe(-1000000n);
    expect(Object.values(ledger).reduce((sum, value) => sum + value, 0n)).toBe(0n);
    // Yesterday's cash: the deposit came in; the oil and the helper went out.
    const cash = await request(http).get("/api/v1/money/cash").query({ date: lagosDay(-1) }).set(auth(owner)).expect(200);
    const flows = Object.fromEntries(cash.body.data.shops[0].flows.map((flow: { kind: string; inMinor: string; outMinor: string }) => [flow.kind, flow]));
    expect(flows.deposits).toMatchObject({ inMinor: "1000000" });
    expect(flows.job_costs).toMatchObject({ outMinor: "200000" });
    expect(flows.stock_bought).toMatchObject({ outMinor: "1200000" });
  });

  it("finds the customer again by phone, refuses days too far back, and keeps the sales desk from taking money", async () => {
    const again = await request(http).post("/api/v1/jobs").set(auth(desk)).send({ customer: { name: "Okeke", phone: "+234 803 123 4567" }, title: "Wheel balancing" }).expect(201);
    expect(again.body.data.customer.id).toBe(customerId);
    await request(http).post(`/api/v1/jobs/${again.body.data.job.id}/payments`).set(auth(desk)).send({ method: "cash", amountMinor: "500000" }).expect(403);
    await request(http).post("/api/v1/jobs").set(auth(cashier)).send({ customerId, day: lagosDay(-40) }).expect(400);
    await request(http).post("/api/v1/jobs").set(auth(cashier)).send({ customerId, day: lagosDay(2) }).expect(400);
    // An empty job is cancelled by the person who opened it.
    await request(http).post(`/api/v1/jobs/${again.body.data.job.id}/cancel`).set(auth(desk)).send({ reason: "Customer changed his mind" }).expect(200);
  });

  it("removes lines: the helper's pay comes back, parts go back on the shelf, and only managers remove others' lines", async () => {
    const view = (await request(http).get(`/api/v1/jobs/${jobId}`).set(auth(owner)).expect(200)).body.data;
    const helper = view.lines.find((line: { kind: string }) => line.kind === "helper");
    const disc = view.lines.find((line: { kind: string }) => line.kind === "part");
    await request(http).post(`/api/v1/jobs/${jobId}/lines/${helper.id}/remove`).set(auth(cashier)).send({ reason: "" }).expect(400);
    await request(http).post(`/api/v1/jobs/${jobId}/lines/${helper.id}/remove`).set(auth(cashier)).send({ reason: "He did not come" }).expect(200);
    expect((await books())["1350"]).toBe(2400000n);
    // The owner adds wheel alignment and a second disc; the cashier cannot remove the owner's line.
    const added = await request(http)
      .post(`/api/v1/jobs/${jobId}/lines`)
      .set(auth(owner))
      .send({ lines: [{ kind: "work", description: "Wheel alignment", unitPriceMinor: "500000" }, { kind: "part", productId: discId, quantity: "1", unit: "piece" }] })
      .expect(200);
    const second = added.body.data.lines.filter((line: { kind: string; removed: unknown }) => line.kind === "part" && !line.removed)[1];
    await request(http).post(`/api/v1/jobs/${jobId}/lines/${second.id}/remove`).set(auth(cashier)).send({ reason: "Not needed" }).expect(403);
    await request(http).post(`/api/v1/jobs/${jobId}/lines/${second.id}/remove`).set(auth(owner)).send({ reason: "Not needed" }).expect(200);
    expect(await onHand(discId)).toBe(4000n);
    expect(disc.costMinor).toBe("1200000");
    // More parts than are on the shelf are refused.
    await request(http).post(`/api/v1/jobs/${jobId}/lines`).set(auth(owner)).send({ lines: [{ kind: "part", productId: discId, quantity: "9", unit: "piece" }] }).expect(422);
  });

  it("finishes the job: one bill, deposits off, cost of sales from the job, the rest owed on this job only", async () => {
    // An older debt from the same customer.
    await request(http).patch(`/api/v1/customers/${customerId}`).set(auth(owner)).send({ name: "Mr Okeke", phone: "08031234567", creditAllowed: true }).expect(200);
    const older = await request(http)
      .post("/api/v1/sales")
      .set(auth(owner))
      .send({ customerId, lines: [{ description: "Diagnosis", unitPriceMinor: "300000" }], payments: [], dueDate: lagosDay(7), comment: "Pays with the car" })
      .expect(201);
    expect(older.body.data.sale.balanceMinor).toBe("300000");

    const finished = await request(http).post(`/api/v1/jobs/${jobId}/finish`).set(auth(owner)).send({ dueDate: lagosDay(14) }).expect(200);
    const view = finished.body.data;
    expect(view.job.status).toBe("done");
    expect(view.sale).toMatchObject({ totalMinor: "5200000", paidMinor: "1000000", balanceMinor: "4200000", dueDate: lagosDay(14) });
    expect(view.sale.invoiceNumber).toMatch(/^INV-/);
    expect(view.totals).toMatchObject({ chargedMinor: "5200000", leftMinor: "4200000", costMinor: "2400000", profitMinor: "2800000" });
    await request(http).post(`/api/v1/jobs/${jobId}/lines`).set(auth(owner)).send({ lines: [{ kind: "work", description: "Extra", unitPriceMinor: "100" }] }).expect(409);

    const ledger = await books();
    expect(ledger["1350"]).toBe(0n);
    expect(ledger["2100"]).toBe(0n);
    expect(ledger["4050"]).toBe(-(2000000n + 300000n));
    expect(ledger["4000"]).toBe(-3200000n);
    expect(Object.values(ledger).reduce((sum, value) => sum + value, 0n)).toBe(0n);
    const bill = await request(http).get(`/api/v1/sales/${view.sale.id}`).set(auth(owner)).expect(200);
    expect(bill.body.data.sale.lines.map((line: { description: string }) => line.description)).toEqual(["Brake pad replacement", "Brake disc", "Engine oil", "Wheel alignment"]);

    // A payment on the job goes to this job, not the older debt.
    const paid = await request(http).post(`/api/v1/jobs/${jobId}/payments`).set(auth(cashier)).send({ method: "cash", amountMinor: "1200000" }).expect(200);
    expect(paid.body.data.totals.leftMinor).toBe("3000000");
    const olderNow = await request(http).get(`/api/v1/sales/${older.body.data.sale.id}`).set(auth(owner)).expect(200);
    expect(olderNow.body.data.sale.balanceMinor).toBe("300000");

    // Cancelling the deposit after billing: the customer owes it on this job again.
    const deposit = view.payments[0];
    await request(http).post(`/api/v1/payments/${deposit.id}/void`).set(auth(owner)).send({ reason: "Counted wrongly" }).expect(200);
    const after = (await request(http).get(`/api/v1/jobs/${jobId}`).set(auth(owner)).expect(200)).body.data;
    expect(after.sale.balanceMinor).toBe("4000000");
    const final = await books();
    expect(final["2100"]).toBe(0n);
    expect(Object.values(final).reduce((sum, value) => sum + value, 0n)).toBe(0n);
    const jobs = await request(http).get("/api/v1/jobs").query({ customerId }).set(auth(cashier)).expect(200);
    expect(jobs.body.data.items.find((item: { id: string }) => item.id === jobId)).toMatchObject({ status: "done", chargedMinor: "5200000", leftMinor: "4000000" });
  });

  it("refuses to bill less than the deposits, and to cancel a job with money on it", async () => {
    const small = await request(http)
      .post("/api/v1/jobs")
      .set(auth(cashier))
      .send({ customerId, lines: [{ kind: "work", description: "Fuse change", unitPriceMinor: "100000" }], payment: { method: "cash", amountMinor: "500000" } })
      .expect(201);
    const id = small.body.data.job.id;
    expect((await request(http).post(`/api/v1/jobs/${id}/finish`).set(auth(cashier)).send({}).expect(409)).body.error.code).toBe("DEPOSIT_MORE_THAN_BILL");
    expect((await request(http).post(`/api/v1/jobs/${id}/cancel`).set(auth(cashier)).send({ reason: "Wrong job" }).expect(409)).body.error.code).toBe("JOB_NOT_EMPTY");
    // A job done while the customer waits: opened, paid and finished at once.
    const quick = await request(http)
      .post("/api/v1/jobs")
      .set(auth(cashier))
      .send({ customer: { name: "Mrs Bello" }, lines: [{ kind: "work", description: "Tyre patch", unitPriceMinor: "150000" }], payment: { method: "cash", amountMinor: "150000" }, finish: true })
      .expect(201);
    expect(quick.body.data.job.status).toBe("done");
    expect(quick.body.data.sale).toMatchObject({ totalMinor: "150000", balanceMinor: "0", invoiceNumber: null });
  });

  it("sells something not in the products at the counter, as service income", async () => {
    const before = (await books())["4050"] ?? 0n;
    const sold = await request(http).post("/api/v1/sales").set(auth(cashier)).send({ lines: [{ description: "Phone screen fixing", unitPriceMinor: "800000" }], payments: [{ method: "cash", amountMinor: "800000" }] }).expect(201);
    expect(sold.body.data.sale.lines[0]).toMatchObject({ description: "Phone screen fixing" });
    expect((await books())["4050"]).toBe(before - 800000n);
  });

  it("reads a spoken job into rows for the cashier to check", async () => {
    const heard = await request(http)
      .post("/api/v1/captures")
      .set(auth(cashier))
      .send({ target: "job", files: [{ mimeType: "audio/webm", data: Buffer.from("voice").toString("base64") }] })
      .expect(200);
    expect(heard.body.data.rows.map((row: { kind: string }) => row.kind)).toEqual(["work", "bought", "helper", "payment"]);
    expect(heard.body.data.rows[0]).toMatchObject({ customer: "Mr Okeke", title: "Toyota Camry, LND 123 AB" });
    expect(heard.body.data.rows[0].summary).toContain("Mr Okeke");
    // Nothing is saved by hearing it.
    expect((await client.query("SELECT 1 FROM jobs WHERE tenant_id = $1 AND title = 'Toyota Camry, LND 123 AB'", [tenantId])).rows).toHaveLength(1);
  });
});
