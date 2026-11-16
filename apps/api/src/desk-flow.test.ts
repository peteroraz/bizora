import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
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
      email: `owner.${label}@desk.test`,
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

describe("sales desk, cashier and store keeper (desk flow)", () => {
  let app: INestApplication;
  let client: PGlite;
  let a: Awaited<ReturnType<typeof registerOwner>>;
  let b: Awaited<ReturnType<typeof registerOwner>>;
  let ledger: LedgerPostingService;
  let salesToken = "";
  let cashierToken = "";
  let storeToken = "";
  let managerToken = "";
  let milkId = "";
  let chikaId = "";
  let musaId = "";
  let creditSaleId = "";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = (rows: { code: string; balanceMinor: bigint }[], code: string) => rows.find((row) => row.code === code)?.balanceMinor ?? 0n;
  const onHand = async () => {
    const product = await request(app.getHttpServer()).get(`/api/v1/products/${milkId}`).set(auth(a.token)).expect(200);
    return product.body.data.product.stock.quantity as string;
  };
  const inbox = async (token: string) => (await request(app.getHttpServer()).get("/api/v1/notifications").set(auth(token)).expect(200)).body.data;
  const binary = (response: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
  };
  const tins = (count: number) => ({ lines: [{ productId: milkId, quantity: String(count), unit: "tin" }] });

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    const http = app.getHttpServer();
    a = await registerOwner(http, "a");
    b = await registerOwner(http, "b");
    ledger = app.get(LedgerPostingService);
    salesToken = await invite(http, a.token, "sales@desk.test", "SALES", a.branchId, a.businessId);
    cashierToken = await invite(http, a.token, "cashier@desk.test", "CASHIER", a.branchId, a.businessId);
    storeToken = await invite(http, a.token, "store@desk.test", "INVENTORY", a.branchId, a.businessId);
    managerToken = await invite(http, a.token, "manager@desk.test", "MANAGER", a.branchId, a.businessId);
    await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(auth(storeToken)).send({ salesFlow: "desk" }).expect(403);
    const switched = await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(auth(a.token)).send({ salesFlow: "desk" }).expect(200);
    expect(switched.body.data.business.salesFlow).toBe("desk");
    const milk = await request(http)
      .post("/api/v1/products")
      .set(auth(a.token))
      .send({ name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "96", openingCostMinor: "3360000" })
      .expect(201);
    milkId = milk.body.data.product.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("lets only managers and owners approve customers for credit and set their limit", async () => {
    const http = app.getHttpServer();
    const refused = await request(http).post("/api/v1/customers").set(auth(salesToken)).send({ name: "Mama Chika", phone: "08031234567", creditAllowed: true }).expect(403);
    expect(refused.body.error.message).toContain("manager or owner");
    const chika = await request(http).post("/api/v1/customers").set(auth(salesToken)).send({ name: "Mama Chika", phone: "08031234567" }).expect(201);
    chikaId = chika.body.data.customer.id;
    expect(chika.body.data.customer.credit).toMatchObject({ allowed: false, limitMinor: null });
    const musa = await request(http)
      .post("/api/v1/customers")
      .set(auth(managerToken))
      .send({ name: "Alhaji Musa", phone: "08039876543", creditAllowed: true, creditLimitMinor: "1000000" })
      .expect(201);
    musaId = musa.body.data.customer.id;
    expect(musa.body.data.customer.credit).toMatchObject({ allowed: true, limitMinor: "1000000" });
    // Editing other details keeps the approval; only managers can change it.
    await request(http).patch(`/api/v1/customers/${musaId}`).set(auth(salesToken)).send({ name: "Alhaji Musa Bello", phone: "08039876543" }).expect(200);
    await request(http).patch(`/api/v1/customers/${musaId}`).set(auth(salesToken)).send({ name: "Alhaji Musa Bello", phone: "08039876543", creditLimitMinor: "9000000" }).expect(403);
    const kept = await request(http).get(`/api/v1/customers/${musaId}`).set(auth(managerToken)).expect(200);
    expect(kept.body.data.customer.credit).toMatchObject({ allowed: true, limitMinor: "1000000" });
    // Approving later, from the customer's page.
    await request(http).patch(`/api/v1/customers/${chikaId}/credit`).set(auth(cashierToken)).send({ creditAllowed: true }).expect(403);
    const later = await request(http).patch(`/api/v1/customers/${chikaId}/credit`).set(auth(managerToken)).send({ creditAllowed: true, creditLimitMinor: "500000" }).expect(200);
    expect(later.body.data.customer.credit).toMatchObject({ allowed: true, limitMinor: "500000" });
    await request(http).patch(`/api/v1/customers/${chikaId}/credit`).set(auth(managerToken)).send({ creditAllowed: false }).expect(200);
  });

  it("goes from the sales desk to the cashier to the store keeper, and posts money first and stock last", async () => {
    const http = app.getHttpServer();
    const paid = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(2), payments: [{ method: "cash", amountMinor: "90000" }] }).expect(400);
    expect(paid.body.error.code).toBe("PAY_AT_CASHIER");
    const created = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(2), requestedPayment: "cash" }).expect(201);
    const sale = created.body.data.sale;
    expect(sale).toMatchObject({ number: null, invoiceNumber: "INV-000001", status: "awaiting_payment", paymentState: "unpaid", paidMinor: "0", balanceMinor: "90000", requestedPayment: "cash" });
    expect(await onHand()).toBe("96000");
    let trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(balance(trial.accounts, "4000")).toBe(0n);

    // The store keeper does not see it until the cashier is done; the sales person cannot take the money.
    await request(http).get(`/api/v1/sales/${sale.id}`).set(auth(storeToken)).expect(404);
    await request(http).post(`/api/v1/sales/${sale.id}/collect`).set(auth(salesToken)).send({ payments: [{ method: "cash", amountMinor: "90000" }] }).expect(403);

    const queue = await request(http).get("/api/v1/sales").query({ status: "awaiting_payment" }).set(auth(cashierToken)).expect(200);
    expect(queue.body.data.items.map((item: { id: string }) => item.id)).toEqual([sale.id]);
    const queues = await request(http).get("/api/v1/sales/queues").set(auth(cashierToken)).expect(200);
    expect(queues.body.data).toMatchObject({ salesFlow: "desk", awaitingPayment: 1, awaitingRelease: null });

    const collected = await request(http).post(`/api/v1/sales/${sale.id}/collect`).set(auth(cashierToken)).send({ payments: [{ method: "cash", amountMinor: "90000" }] }).expect(200);
    expect(collected.body.data.sale).toMatchObject({ number: "R-000001", invoiceNumber: "INV-000001", status: "awaiting_release", paymentState: "paid", paidMinor: "90000", collectedByName: "cashier@desk.test" });
    await request(http).post(`/api/v1/sales/${sale.id}/collect`).set(auth(cashierToken)).send({ payments: [{ method: "cash", amountMinor: "90000" }] }).expect(409);
    trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1000-01")).toBe(90_000n);
    expect(balance(trial.accounts, "4000")).toBe(-90_000n);
    expect(balance(trial.accounts, "5000")).toBe(0n);
    expect(await onHand()).toBe("96000");

    // The store keeper is told, and sees what to give out without amounts or the customer.
    const storeInbox = await inbox(storeToken);
    expect(storeInbox.unread).toBe(1);
    expect(storeInbox.items[0]).toMatchObject({ kind: "sale.paid", saleId: sale.id, saleNumber: "R-000001", actorName: "cashier@desk.test" });
    expect((await inbox(salesToken)).items[0]).toMatchObject({ kind: "sale.paid", saleId: sale.id });
    const toRelease = await request(http).get("/api/v1/sales").query({ status: "awaiting_release" }).set(auth(storeToken)).expect(200);
    expect(toRelease.body.data.items[0]).toMatchObject({ id: sale.id, view: "release", paymentState: "paid", itemCount: 1 });
    expect(toRelease.body.data.items[0]).not.toHaveProperty("totalMinor");
    const storeView = await request(http).get(`/api/v1/sales/${sale.id}`).set(auth(storeToken)).expect(200);
    expect(storeView.body.data.sale).toMatchObject({ view: "release", lines: [{ description: "Peak Milk", enteredQuantity: "2000", enteredUnit: "tin" }] });
    expect(JSON.stringify(storeView.body.data.sale)).not.toMatch(/Minor|customer|receipt|whatsApp/);

    const released = await request(http).post(`/api/v1/sales/${sale.id}/release`).set(auth(storeToken)).send({ comment: "Given to the customer's driver" }).expect(200);
    expect(released.body.data.sale).toMatchObject({ status: "completed", releasedByName: "store@desk.test", comments: [{ body: "Given to the customer's driver", role: "INVENTORY" }] });
    await request(http).post(`/api/v1/sales/${sale.id}/release`).set(auth(storeToken)).send({}).expect(409);
    expect(await onHand()).toBe("94000");
    trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "5000")).toBe(70_000n);
    expect((await inbox(salesToken)).items[0]).toMatchObject({ kind: "sale.released", actorName: "store@desk.test" });
  });

  it("gives credit only to approved customers, within the limit, with a due date and a comment", async () => {
    const http = app.getHttpServer();
    const forChika = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(2), customerId: chikaId, requestedPayment: "credit" }).expect(201);
    const notApproved = await request(http).post(`/api/v1/sales/${forChika.body.data.sale.id}/collect`).set(auth(cashierToken)).send({ payments: [] }).expect(403);
    expect(notApproved.body.error.code).toBe("CREDIT_NOT_APPROVED");

    const created = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(30), customerId: musaId, requestedPayment: "split", comment: "Customer asked to pay part now" }).expect(201);
    creditSaleId = created.body.data.sale.id;
    const collect = (body: object) => request(http).post(`/api/v1/sales/${creditSaleId}/collect`).set(auth(cashierToken)).send(body);
    // ₦13,500 sale, ₦3,000 paid: ₦10,500 owing is over the ₦10,000 limit.
    expect((await collect({ payments: [{ method: "cash", amountMinor: "300000" }], dueDate: "2099-01-31", comment: "x" }).expect(403)).body.error.code).toBe("OVER_CREDIT_LIMIT");
    expect((await collect({ payments: [{ method: "cash", amountMinor: "400000" }], comment: "Pays Friday" }).expect(400)).body.error.code).toBe("DUE_DATE_REQUIRED");
    expect((await collect({ payments: [{ method: "cash", amountMinor: "400000" }], dueDate: "2020-01-01", comment: "Pays Friday" }).expect(400)).body.error.message).toContain("past");
    expect((await collect({ payments: [{ method: "cash", amountMinor: "400000" }], dueDate: "2099-01-31" }).expect(400)).body.error.code).toBe("COMMENT_REQUIRED");
    const done = await collect({ payments: [{ method: "cash", amountMinor: "400000" }], dueDate: "2099-01-31", comment: "Pays Friday after market" }).expect(200);
    expect(done.body.data.sale).toMatchObject({ status: "awaiting_release", paymentState: "credit", paidMinor: "400000", balanceMinor: "950000", dueDate: "2099-01-31" });
    expect(done.body.data.sale.comments.map((comment: { kind: string; role: string }) => [comment.kind, comment.role])).toEqual([
      ["comment", "SALES"],
      ["credit", "CASHIER"],
    ]);
    expect((await inbox(storeToken)).items[0]).toMatchObject({ kind: "sale.credit", saleId: creditSaleId });
    const musa = await request(http).get(`/api/v1/customers/${musaId}`).set(auth(managerToken)).expect(200);
    expect(musa.body.data.customer.owingMinor).toBe("950000");
    const trial = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(trial.balanced).toBe(true);
    expect(balance(trial.accounts, "1200")).toBe(950_000n);

    // Everyone on the sale can comment; the others are told.
    await request(http).post(`/api/v1/sales/${creditSaleId}/comments`).set(auth(storeToken)).send({ body: "Only 28 tins on the shelf, 2 from the back store" }).expect(200);
    expect((await inbox(cashierToken)).items[0]).toMatchObject({ kind: "sale.comment", saleId: creditSaleId });
    expect((await inbox(salesToken)).items[0]).toMatchObject({ kind: "sale.comment", saleId: creditSaleId });
    await request(http).post(`/api/v1/sales/${creditSaleId}/release`).set(auth(storeToken)).send({}).expect(200);
  });

  it("makes invoice and receipt PDFs for the people who may see the amounts, and for the customer's link", async () => {
    const http = app.getHttpServer();
    const unpaid = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(1) }).expect(201);
    const unpaidId = unpaid.body.data.sale.id as string;
    expect(unpaid.body.data.sale.documents).toEqual(["invoice"]);
    const invoice = await request(http).get(`/api/v1/sales/${unpaidId}/documents/invoice`).set(auth(salesToken)).buffer(true).parse(binary).expect(200);
    expect(invoice.headers["content-type"]).toContain("application/pdf");
    expect(invoice.headers["content-disposition"]).toContain('filename="Invoice-INV-');
    expect(Buffer.from(invoice.body).subarray(0, 5).toString()).toBe("%PDF-");
    const noReceipt = await request(http).get(`/api/v1/sales/${unpaidId}/documents/receipt`).set(auth(salesToken)).expect(404);
    expect(noReceipt.body.error.code).toBe("NO_DOCUMENT");
    await request(http).get(`/api/v1/sales/${unpaidId}/documents/statement`).set(auth(salesToken)).expect(404);

    // The credit sale has both. The store keeper, who sees no amounts, gets neither.
    const credit = await request(http).get(`/api/v1/sales/${creditSaleId}`).set(auth(managerToken)).expect(200);
    expect(credit.body.data.sale.documents).toEqual(["invoice", "receipt"]);
    expect(credit.body.data.sale.whatsApp.text).toMatch(/^Receipt R-\d{6} from /);
    await request(http).get(`/api/v1/sales/${creditSaleId}/documents/invoice`).set(auth(storeToken)).expect(403);
    await request(http).get(`/api/v1/sales/${creditSaleId}/documents/receipt`).set(auth(b.token)).expect(404);
    const token = (credit.body.data.sale.receiptPath as string).replace("/r/", "");
    const publicReceipt = await request(http).get(`/api/v1/public/receipts/${token}`).expect(200);
    expect(publicReceipt.body.data.receipt).toMatchObject({ documents: ["invoice", "receipt"], dueDate: "2099-01-31" });
    const publicPdf = await request(http).get(`/api/v1/public/receipts/${token}/documents/invoice.pdf`).buffer(true).parse(binary).expect(200);
    expect(publicPdf.headers["content-disposition"]).toContain('filename="Credit-invoice-INV-');
    await request(http).get("/api/v1/public/receipts/not-a-real-receipt-token-xx/documents/receipt").expect(404);
    await request(http).post(`/api/v1/sales/${unpaidId}/void`).set(auth(salesToken)).send({ reason: "Test" }).expect(200);
  });

  it("cancels at any stage and undoes only what happened", async () => {
    const http = app.getHttpServer();
    // A sales person may cancel their own sale while it waits for payment.
    const unpaid = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(1) }).expect(201);
    const before = await ledger.trialBalance(a.tenantId, a.businessId);
    const cancelled = await request(http).post(`/api/v1/sales/${unpaid.body.data.sale.id}/void`).set(auth(salesToken)).send({ reason: "Customer left" }).expect(200);
    expect(cancelled.body.data.sale).toMatchObject({ status: "voided", paymentState: "unpaid" });
    // Once paid, only a manager can cancel.
    await request(http).post(`/api/v1/sales/${creditSaleId}/void`).set(auth(salesToken)).send({ reason: "x" }).expect(403);
    const stockBefore = await onHand();
    await request(http).post(`/api/v1/sales/${creditSaleId}/void`).set(auth(managerToken)).send({ reason: "Returned" }).expect(200);
    expect(BigInt(await onHand()) - BigInt(stockBefore)).toBe(30_000n);
    const after = await ledger.trialBalance(a.tenantId, a.businessId);
    expect(after.balanced).toBe(true);
    expect(balance(after.accounts, "1200")).toBe(balance(before.accounts, "1200") - 950_000n);
    const musa = await request(http).get(`/api/v1/customers/${musaId}`).set(auth(managerToken)).expect(200);
    expect(musa.body.data.customer.owingMinor).toBe("0");
  });

  it("totals what each person handled, keeps notifications personal, and keeps organizations apart", async () => {
    const http = app.getHttpServer();
    const cashier = await request(http).get("/api/v1/sales/summary").set(auth(cashierToken)).expect(200);
    // The first sale (₦900) counts; the credit sale was cancelled.
    expect(cashier.body.data).toMatchObject({ mine: true, count: 1, totalMinor: "90000" });
    const read = await request(http).post("/api/v1/notifications/read").set(auth(storeToken)).send({ all: true }).expect(200);
    expect(read.body.data.unread).toBe(0);
    expect((await inbox(b.token)).items).toEqual([]);
    const pending = await request(http).post("/api/v1/sales").set(auth(salesToken)).send({ ...tins(1) }).expect(201);
    await request(http).post(`/api/v1/sales/${pending.body.data.sale.id}/collect`).set(auth(b.token)).send({ payments: [] }).expect(404);
    await request(http).post(`/api/v1/sales/${pending.body.data.sale.id}/comments`).set(auth(b.token)).send({ body: "hello" }).expect(404);
    const mine = await request(http).get("/api/v1/sales/queues").set(auth(salesToken)).expect(200);
    // Mama Chika's unapproved credit sale still waits, and so does this one.
    expect(mine.body.data).toMatchObject({ mineWaiting: 2, awaitingPayment: null });
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
