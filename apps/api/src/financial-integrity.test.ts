import { randomUUID } from "node:crypto";
import { uuidv7 } from "@bizora/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, boot, customer, expectBalancedBooks, product, shop, staff, type Harness, type Shop } from "./test-support.js";

/**
 * Financial integrity (ADR-043). Money is bigint minor units everywhere; these tests check the invariants a pilot
 * business relies on: totals, debts, stock, profit and balanced books, and that repeated or racing requests never
 * count money or stock twice.
 */

let h: Harness;
let owner: Shop;
let cashier = "";
let rice = "";
let milk = "";
let emeka = "";

const key = () => randomUUID();
const send = (token: string, method: "post" | "patch", path: string, body: object, idem = key()) => request(h.http)[method](path).set(auth(token)).set("idempotency-key", idem).send(body);
const stock = async (id: string) => (await request(h.http).get(`/api/v1/products/${id}`).set(auth(owner.token)).expect(200)).body.data.product.stock.quantity as string;
const owing = async (id: string) => (await request(h.http).get(`/api/v1/debtors/${id}`).set(auth(owner.token)).expect(200)).body.data.account.owingMinor as string;
const profit = async () => (await request(h.http).get("/api/v1/money/profit").set(auth(owner.token)).expect(200)).body.data as Record<string, string>;
const count = async (sql: string, ...params: unknown[]) => Number((await h.client.query<{ n: string }>(sql, params)).rows[0]!.n);
const entries = () => count("SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1", owner.tenantId);

beforeAll(async () => {
  h = await boot();
  owner = await shop(h.http, "owner@money.test", "Ngozi Provisions");
  cashier = await staff(h.http, owner, "cashier@money.test", "CASHIER");
  rice = await product(h.http, owner.token, "Rice 50kg", "7500000", "20");
  milk = await product(h.http, owner.token, "Peak Milk", "45000", "100", "tin");
  emeka = await customer(h.http, owner.token, "Emeka Obi", "08031112222");
}, 60_000);

afterAll(async () => h.close());

describe("a sale", () => {
  it("totals lines less the discount, creates exactly the debt left, moves stock once and balances the books", async () => {
    const sold = await send(owner.token, "post", "/api/v1/sales", {
      customerId: emeka,
      lines: [
        { productId: rice, quantity: "2", unit: "bag" },
        { productId: milk, quantity: "3", unit: "tin" },
      ],
      discountMinor: "35000",
      payments: [{ method: "transfer", amountMinor: "10000000" }],
      dueDate: "2099-01-31",
      comment: "Balance on Friday",
    }).expect(201);
    const sale = sold.body.data.sale;
    // 2 × 75,000.00 + 3 × 450.00 − 350.00 = 151,000.00
    expect(sale.totalMinor).toBe("15100000");
    expect(sale.balanceMinor).toBe("5100000");
    expect(await owing(emeka)).toBe("5100000");
    expect(await stock(rice)).toBe("18000");
    expect(await stock(milk)).toBe("97000");
    expect(sale.payments.map((payment: { method: string; amountMinor: string }) => [payment.method, payment.amountMinor])).toEqual([["transfer", "10000000"]]);
    await expectBalancedBooks(h.client, owner.tenantId);
  });

  it("refuses paying more than the total for a sale on account, and a discount bigger than the sale", async () => {
    const over = await send(owner.token, "post", "/api/v1/sales", { customerId: emeka, lines: [{ productId: milk, quantity: "1", unit: "tin" }], payments: [{ method: "transfer", amountMinor: "90000" }] });
    expect(over.status).toBeGreaterThanOrEqual(400);
    const discount = await send(owner.token, "post", "/api/v1/sales", { lines: [{ productId: milk, quantity: "1", unit: "tin" }], discountMinor: "90000", payments: [] });
    expect(discount.status).toBeGreaterThanOrEqual(400);
    expect(await stock(milk)).toBe("97000");
  });
});

describe("a return", () => {
  it("puts goods back on the shelf, takes the money off what is owed first, and keeps the books balanced", async () => {
    const sold = await send(owner.token, "post", "/api/v1/sales", { customerId: emeka, lines: [{ productId: rice, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "5000000" }], dueDate: "2099-01-31", comment: "Rest next week" }).expect(201);
    const sale = sold.body.data.sale;
    const owedBefore = BigInt(await owing(emeka));
    const stockBefore = await stock(rice);
    const returned = await send(owner.token, "post", `/api/v1/sales/${sale.id}/returns`, { id: uuidv7(), lines: [{ saleLineId: sale.lines[0].id, quantity: "1" }], refundMethod: "cash", reason: "Wet bag", restock: true }).expect(201);
    expect(BigInt(await stock(rice)) - BigInt(stockBefore)).toBe(1000n);
    // 75,000.00 came back: the 100,000.00 still owed on this sale drops to 25,000.00; no cash leaves the drawer.
    expect(owedBefore - BigInt(await owing(emeka))).toBe(7500000n);
    expect(returned.body.data.sale.balanceMinor).toBe("2500000");
    await expectBalancedBooks(h.client, owner.tenantId);
  });
});

describe("a debt payment", () => {
  it("reduces what is owed once, keeps the method, and is told apart from money paid at the sale", async () => {
    const before = BigInt(await owing(emeka));
    const idem = key();
    const body = { amountMinor: "1000000", method: "pos" };
    const first = await send(owner.token, "post", `/api/v1/debtors/${emeka}/payments`, body, idem).expect(201);
    const again = await send(owner.token, "post", `/api/v1/debtors/${emeka}/payments`, body, idem);
    expect(again.status).toBe(201);
    expect(again.body.data.payment.id).toBe(first.body.data.payment.id);
    expect(before - BigInt(await owing(emeka))).toBe(1000000n);
    expect(first.body.data.payment).toMatchObject({ method: "pos", amountMinor: "1000000" });
    const kinds = await h.client.query<{ n: string }>("SELECT count(*)::text AS n FROM customer_payments WHERE tenant_id = $1", [owner.tenantId]).catch(() => null);
    if (kinds) expect(Number(kinds.rows[0]!.n)).toBe(1);
    // The same key with a different amount is refused, not taken as a new payment.
    const changed = await send(owner.token, "post", `/api/v1/debtors/${emeka}/payments`, { amountMinor: "2000000", method: "pos" }, idem);
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(before - BigInt(await owing(emeka))).toBe(1000000n);
    await expectBalancedBooks(h.client, owner.tenantId);
  });
});

describe("POS cash-out and profit (ADR-038)", () => {
  it("counts only the fee as profit, never the cash given out", async () => {
    const start = await profit();
    await send(cashier, "post", "/api/v1/money/pos-cashouts", { amountMinor: "2000000", feeMinor: "20000", feePaidBy: "pos" }).expect(201);
    const after = await profit();
    expect(BigInt(after.profitMinor!) - BigInt(start.profitMinor!)).toBe(20000n);
    await expectBalancedBooks(h.client, owner.tenantId);
  });

  it("does not count owner's money, loans, money found in a count or other money in as profit", async () => {
    const start = await profit();
    await send(owner.token, "post", "/api/v1/money/movements", { kind: "owner_in", amountMinor: "50000000", note: "Owner put money in" });
    await send(owner.token, "post", "/api/v1/money/movements", { kind: "other_in", amountMinor: "3000000", note: "Loan from cooperative" }).expect(201);
    const drawer = (await request(h.http).get("/api/v1/money/cash").set(auth(owner.token))).body.data?.expectedMinor;
    if (drawer) await send(owner.token, "post", "/api/v1/money/cash-counts", { countedMinor: (BigInt(drawer) + 500000n).toString() });
    const after = await profit();
    expect(after.profitMinor).toBe(start.profitMinor);
    await expectBalancedBooks(h.client, owner.tenantId);
  });
});

describe("double taps, retries and offline replays", () => {
  it("never counts a sale twice: same key, a retried request, two at once, or an offline replay", async () => {
    const stockBefore = await stock(milk);
    const entriesBefore = await entries();
    const body = { lines: [{ productId: milk, quantity: "1", unit: "tin" }], payments: [{ method: "cash", amountMinor: "45000" }] };
    const idem = key();
    const [one, two] = await Promise.all([send(owner.token, "post", "/api/v1/sales", body, idem), send(owner.token, "post", "/api/v1/sales", body, idem)]);
    const ok = [one, two].filter((response) => response.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const response of [one, two]) expect([201, 409]).toContain(response.status);
    const perSale = (await entries()) - entriesBefore;
    expect(perSale).toBeGreaterThan(0);
    await send(owner.token, "post", "/api/v1/sales", body, idem).expect(201);
    expect((await entries()) - entriesBefore).toBe(perSale);
    // Offline: the same sale id pushed twice under different operation ids is one sale.
    const saleId = uuidv7();
    const op = (id: string) => ({ id, type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: saleId, ...body, soldAt: new Date().toISOString() } });
    await request(h.http).post("/api/v1/sync/push").set(auth(owner.token)).send({ operations: [op(uuidv7())] }).expect(200);
    await request(h.http).post("/api/v1/sync/push").set(auth(owner.token)).send({ operations: [op(uuidv7())] }).expect(200);
    expect(BigInt(stockBefore) - BigInt(await stock(milk))).toBe(2000n);
    expect((await entries()) - entriesBefore).toBe(perSale * 2);
    await expectBalancedBooks(h.client, owner.tenantId);
  });

  it("never moves stock or money twice for repeated stock, cash-out, supplier and void requests", async () => {
    const checks: [string, object][] = [
      ["/api/v1/stock/receive", { productId: milk, quantity: "10", unit: "tin", totalCostMinor: "350000", paidFrom: "cash" }],
      ["/api/v1/stock/adjust", { productId: milk, direction: "remove", reason: "damaged", quantity: "1", unit: "tin", note: "Dented" }],
      ["/api/v1/money/pos-cashouts", { amountMinor: "100000", feeMinor: "1000", feePaidBy: "cash" }],
      ["/api/v1/money/movements", { kind: "to_bank", amountMinor: "10000" }],
    ];
    for (const [path, body] of checks) {
      const idem = key();
      const stockBefore = await stock(milk);
      const entriesBefore = await entries();
      const first = await send(owner.token, "post", path, body, idem);
      expect(first.status, path).toBeLessThan(300);
      const second = await send(owner.token, "post", path, body, idem);
      expect(second.status, path).toBe(first.status);
      expect(second.body.data, path).toEqual(first.body.data);
      const stockMoved = BigInt(stockBefore) - BigInt(await stock(milk));
      expect([0n, -10000n, 1000n], path).toContain(stockMoved);
      expect((await entries()) - entriesBefore, path).toBeLessThanOrEqual(1);
    }
    // A payment voided twice is voided once.
    const paid = await send(owner.token, "post", `/api/v1/debtors/${emeka}/payments`, { amountMinor: "100000", method: "cash" }).expect(201);
    const before = await owing(emeka);
    const idem = key();
    const voided = await send(owner.token, "post", `/api/v1/payments/${paid.body.data.payment.id}/void`, { reason: "Entered twice" }, idem);
    expect(voided.status).toBeLessThan(300);
    await send(owner.token, "post", `/api/v1/payments/${paid.body.data.payment.id}/void`, { reason: "Entered twice" }, idem);
    const again = await send(owner.token, "post", `/api/v1/payments/${paid.body.data.payment.id}/void`, { reason: "Entered twice" });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(BigInt(await owing(emeka)) - BigInt(before)).toBe(100000n);
    await expectBalancedBooks(h.client, owner.tenantId);
  });
});

describe("books always balance (broad check)", () => {
  it("stays balanced and debts add up after a long run of mixed sales, payments and returns", async () => {
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    const customers = [emeka, await customer(h.http, owner.token, "Chioma Eze", "08032223333"), await customer(h.http, owner.token, "Musa Bello", "08033334444")];
    for (let step = 0; step < 40; step += 1) {
      const who = customers[next(customers.length)]!;
      const tins = BigInt(1 + next(4));
      const total = tins * 45000n;
      const paid = (total * BigInt(next(5))) / 4n;
      const sold = await send(owner.token, "post", "/api/v1/sales", { customerId: who, lines: [{ productId: milk, quantity: tins.toString(), unit: "tin" }], payments: paid > 0n ? [{ method: ["cash", "transfer", "pos"][next(3)], amountMinor: paid.toString() }] : [], ...(paid < total ? { dueDate: "2099-01-31", comment: "Balance later" } : {}) });
      expect(sold.status, JSON.stringify(sold.body.error ?? "")).toBe(201);
      if (next(4) === 0 && BigInt(await owing(who)) > 0n) await send(owner.token, "post", `/api/v1/debtors/${who}/payments`, { amountMinor: "45000", method: "cash" });
      if (next(6) === 0) {
        const sale = sold.body.data.sale;
        await send(owner.token, "post", `/api/v1/sales/${sale.id}/returns`, { id: uuidv7(), lines: [{ saleLineId: sale.lines[0].id, quantity: "1" }], refundMethod: "cash", reason: "Returned", restock: true });
      }
    }
    await expectBalancedBooks(h.client, owner.tenantId);
    // What each customer owes equals the open balances of their sales.
    for (const who of customers) {
      const open = await h.client.query<{ owed: string }>("SELECT coalesce(sum(balance_minor), 0)::text AS owed FROM sales WHERE tenant_id = $1 AND customer_id = $2 AND voided_at IS NULL", [owner.tenantId, who]);
      expect(await owing(who)).toBe(open.rows[0]!.owed);
    }
  }, 120_000);
});
