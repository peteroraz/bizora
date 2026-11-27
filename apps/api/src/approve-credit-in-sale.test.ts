import "reflect-metadata";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, boot, customer, expectBalancedBooks, product, shop, staff, type Harness, type Shop } from "./test-support.js";

/** App review, 26 Nov: an owner selling on credit to a new customer no longer has to leave the sale to approve them. */
describe("approving a customer for credit inside the sale", () => {
  let harness: Harness;
  let owner: Shop;
  let riceId: string;

  beforeAll(async () => {
    harness = await boot();
    owner = await shop(harness.http, "credit-owner@approve.test", "Bisi Provisions");
    riceId = await product(harness.http, owner.token, "Rice 5kg", "500000", "20", "bag");
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  function creditSale(token: string, customerId: string, extra: Record<string, unknown> = {}) {
    return request(harness.http)
      .post("/api/v1/sales")
      .set(auth(token))
      .send({ customerId, lines: [{ productId: riceId, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "200000" }], dueDate: "2099-12-31", ...extra });
  }

  async function creditAllowed(customerId: string) {
    const rows = await harness.client.query<{ credit_allowed: boolean }>("SELECT credit_allowed FROM customers WHERE id = $1", [customerId]);
    return rows.rows[0]?.credit_allowed;
  }

  it("still refuses credit to a customer nobody approved", async () => {
    const emeka = await customer(harness.http, owner.token, "Emeka Obi", "08031234567", false);
    const refused = await creditSale(owner.token, emeka, { comment: "Pays Friday" }).expect(403);
    expect(refused.body.error.code).toBe("CREDIT_NOT_APPROVED");
    expect(await creditAllowed(emeka)).toBe(false);
  });

  it("lets the owner approve the customer and sell in one step, with no comment needed", async () => {
    const emeka = await customer(harness.http, owner.token, "Emeka Okafor", "08031234568", false);
    const sold = await creditSale(owner.token, emeka, { approveCredit: true }).expect(201);
    expect(sold.body.data.sale).toMatchObject({ balanceMinor: "800000" });
    expect(await creditAllowed(emeka)).toBe(true);

    const audit = await harness.client.query<{ metadata_json: string }>(
      "SELECT metadata_json FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'customer.credit_changed'",
      [owner.tenantId, emeka],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.parse(audit.rows[0]?.metadata_json ?? "{}")).toMatchObject({ creditAllowed: true, saleId: sold.body.data.sale.id });

    const comments = await harness.client.query<{ body: string; kind: string }>("SELECT body, kind FROM sale_comments WHERE sale_id = $1", [sold.body.data.sale.id]);
    expect(comments.rows).toEqual([{ body: "Approved for credit at this sale.", kind: "credit" }]);
    await expectBalancedBooks(harness.client, owner.tenantId);

    // The approval stays, so the next credit sale to them needs nothing extra.
    await creditSale(owner.token, emeka, { comment: "Second bag" }).expect(201);
  });

  it("keeps the comment the owner wrote", async () => {
    const ngozi = await customer(harness.http, owner.token, "Ngozi Eze", "08031234569", false);
    const sold = await creditSale(owner.token, ngozi, { approveCredit: true, comment: "Pays when her shipment lands" }).expect(201);
    const comments = await harness.client.query<{ body: string }>("SELECT body FROM sale_comments WHERE sale_id = $1", [sold.body.data.sale.id]);
    expect(comments.rows.map((row) => row.body)).toEqual(["Pays when her shipment lands"]);
  });

  it("refuses the approval from staff who cannot approve credit, and changes nothing", async () => {
    const cashier = await staff(harness.http, owner, "cashier@approve.test", "CASHIER");
    const tunde = await customer(harness.http, owner.token, "Tunde Bello", "08031234570", false);
    const refused = await creditSale(cashier, tunde, { approveCredit: true, comment: "Regular" }).expect(403);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    expect(await creditAllowed(tunde)).toBe(false);
    const sales = await harness.client.query("SELECT 1 FROM sales WHERE customer_id = $1", [tunde]);
    expect(sales.rows).toHaveLength(0);
  });

  it("lets an owner collecting a sales-desk sale approve the customer, but not the cashier", async () => {
    const desk = await shop(harness.http, "desk-owner@approve.test", "Desk Stores");
    const tins = await product(harness.http, desk.token, "Milk tin", "150000", "20", "tin");
    await request(harness.http).patch(`/api/v1/businesses/${desk.businessId}`).set(auth(desk.token)).send({ salesFlow: "desk" }).expect(200);
    const seller = await staff(harness.http, desk, "sales@approve.test", "SALES");
    const cashier = await staff(harness.http, desk, "desk-cashier@approve.test", "CASHIER");
    const chika = await customer(harness.http, desk.token, "Chika Ude", "08031234572", false);
    const sale = await request(harness.http)
      .post("/api/v1/sales")
      .set(auth(seller))
      .send({ customerId: chika, lines: [{ productId: tins, quantity: "2", unit: "tin" }], requestedPayment: "credit" })
      .expect(201);
    const collect = (token: string) =>
      request(harness.http).post(`/api/v1/sales/${sale.body.data.sale.id}/collect`).set(auth(token)).send({ payments: [], approveCredit: true, dueDate: "2099-12-31" });
    expect((await collect(cashier).expect(403)).body.error.code).toBe("FORBIDDEN");
    expect(await creditAllowed(chika)).toBe(false);
    await collect(desk.token).expect(200);
    expect(await creditAllowed(chika)).toBe(true);
    await expectBalancedBooks(harness.client, desk.tenantId);
  });

  it("does not approve anyone when the sale fails for another reason", async () => {
    const ada = await customer(harness.http, owner.token, "Ada Nwosu", "08031234571", false);
    await creditSale(owner.token, ada, { approveCredit: true, dueDate: "2000-01-01" }).expect(400);
    expect(await creditAllowed(ada)).toBe(false);
  });
});
