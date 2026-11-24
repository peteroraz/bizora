import { randomUUID } from "node:crypto";
import { uuidv7 } from "@bizora/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, boot, customer, product, shop, staff, type Harness, type Shop } from "./test-support.js";

/**
 * Tenant isolation matrix (ADR-043). Business A, signed in as its owner (every permission), attacks business B:
 * every API route that takes an id is called with B's real ids, every list is read, and creates point at B's records.
 * A must get nothing back from B, and not one row of B's data may change. A new route with an id fails this suite
 * until it is added below, so no route goes untested. This replaces database row-level security for the pilot.
 */

// Words only business B's records contain; none may appear in anything A receives.
const MARKERS = ["Bravotenant", "Zebrarice", "Okonkwo Bravo", "Bravo Supplies", "Bravo job", "bravo-cashier"];

type Ids = Record<string, string>;
let h: Harness;
let a: Shop;
let b: Shop;
const ids: Ids = {};

/** For each route with an id: which of B's records the id stands for. Unknown kinds use an id B could own. */
function idFor(path: string, param: string): string {
  const has = (prefix: string) => path.startsWith(`/api/v1/${prefix}`);
  if (param === "type") return "receipt";
  if (param === "kind") return "sale";
  if (param === "code") return "NG";
  if (param === "page") return "sales";
  if (param === "lineId") return has("jobs") ? ids.jobLine! : randomUUID();
  if (param === "photoId" || param === "entryId") return randomUUID();
  if (param === "customerId") return ids.customer!;
  if (param === "priceId") return ids.price!;
  if (param === "productId") return ids.product!;
  // Admin routes are not a business sign-in. The id in /businesses/:id is the tenant.
  if (path.startsWith("/api/admin/")) {
    if (path.includes("/people/")) return ids.user!;
    if (path.includes("/invitations/")) return ids.invitation!;
    if (path.includes("/devices/")) return randomUUID();
    return ids.tenant!;
  }
  const table: [string, string][] = [
    ["branches", ids.branch!],
    ["businesses", ids.business!],
    ["customers", ids.customer!],
    ["followups", ids.followup!],
    ["invitations", ids.invitation!],
    ["jobs", ids.job!],
    ["memberships", ids.membership!],
    ["money/expenses", ids.expense!],
    ["money/movements", ids.movement!],
    ["payments", ids.payment!],
    ["products", ids.product!],
    ["reconciliation", randomUUID()],
    ["sales/problems", ids.problem!],
    ["sales", ids.sale!],
    ["saved-items", ids.savedItem!],
    ["units", ids.unit!],
    ["shop-devices", randomUUID()],
    ["staff", ids.membership!],
    ["catalog/attributes", ids.attribute!],
    ["catalog/products", ids.product!],
    ["catalog/brands", ids.brand!],
    ["catalog/categories", ids.category!],
    ["catalog/items", ids.item!],
    ["inventory/counts", ids.countSession!],
    ["inventory/transfers", ids.transfer!],
    ["pricing/lists", ids.priceList!],
    ["pricing/products", ids.product!],
    ["stock/counts", ids.count!],
    ["stock/receipts", ids.receipt!],
    ["stock/requests", randomUUID()],
    ["suppliers", ids.supplier!],
    ["transfers", ids.sale!],
    ["work-permits", randomUUID()],
  ];
  const found = table.sort((x, y) => y[0].length - x[0].length).find(([prefix]) => has(prefix));
  if (!found) throw new Error(`No tenant isolation mapping for ${path} (:${param}). Add it to tenant-matrix.test.ts.`);
  return found[1];
}

// A body with the fields most routes need, so requests get past validation to the lookup that must refuse them.
const BODY = {
  note: "Probe from another business",
  reason: "Probe from another business",
  decisionNote: "Probe",
  name: "Hijack",
  phone: "08030000000",
  amountMinor: "100",
  method: "cash",
  quantity: "1",
  unit: "bag",
  countedQuantity: "1",
  text: "Probe",
  body: "Probe",
  to: "probe@a.test",
  pin: "4826",
  creditAllowed: true,
  creditLimitMinor: "100",
  dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  lines: [{ quantity: "1", unit: "bag" }],
  payments: [{ method: "cash", amountMinor: "100" }],
  description: "Probe",
  unitPriceMinor: "100",
};

// Routes whose own fields differ from BODY: given here so the request reaches the "is it yours?" check.
const BODIES: Record<string, object> = {
  "PATCH /api/v1/followups/:id": { status: "done", title: "Probe" },
  "PATCH /api/v1/products/:id": { name: "Hijack", priceMinor: "100", reason: "Probe price change", changeReason: "Probe" },
  "PATCH /api/v1/units/:id": { displayName: "Hijack" },
  "POST /api/v1/products/:id/archive": { reason: "Probe" },
  "POST /api/v1/products/:id/photos": { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  "POST /api/v1/stock/counts/:id/approve": {},
  "POST /api/v1/stock/counts/:id/reject": { note: "Probe" },
  "POST /api/v1/sales/:id/returns": { lines: [{ saleLineId: randomUUID(), quantity: "1" }], refundMethod: "cash", restock: true, reason: "Probe" },
  "POST /api/v1/branches/:id/close": { moveToBranchId: randomUUID(), reason: "Probe" },
  "PUT /api/v1/memberships/:id/default-shop": { branchId: randomUUID() },
  "POST /api/v1/jobs/:id/lines": { kind: "work", description: "Probe", quantity: "1", unitPriceMinor: "100" },
  "POST /api/v1/suppliers/:id/payments": { amountMinor: "100", paidFrom: "cash" },
  "POST /api/v1/reconciliation/:lineId/match": { target: { kind: "own_transfer", source: "pos_settlement" } },
};

/** Every row B owns, in every table with a tenant, reduced to a fingerprint. */
async function fingerprint(tenantId: string) {
  const tables = await h.client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema = 'public' AND table_name NOT IN ('audit_events', 'idempotency_keys') ORDER BY table_name",
  );
  const prints: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const result = await h.client.query<{ rows: string; print: string | null }>(
      `SELECT count(*)::text AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS print FROM "${table}" t WHERE t.tenant_id = $1`,
      [tenantId],
    );
    prints[table] = `${result.rows[0]!.rows}:${result.rows[0]!.print ?? ""}`;
  }
  return prints;
}

function leaks(text: string) {
  return MARKERS.filter((marker) => text.includes(marker)).concat(Object.values(ids).filter((id) => text.includes(id)));
}

async function routes() {
  const instance = h.app.getHttpAdapter().getInstance() as { _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }; router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } };
  return (instance._router ?? instance.router)!.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ method: Object.keys(layer.route!.methods)[0]!, path: layer.route!.path }))
    .filter((route) => route.path.startsWith("/api/admin/") || (route.path.startsWith("/api/v1/") && !/\/api\/v1\/(auth|public|reference|health|ready)\b/.test(route.path)));
}

describe("tenant isolation matrix (ADR-043)", () => {
  let before: Record<string, string>;

  beforeAll(async () => {
    h = await boot();
    a = await shop(h.http, "owner-a@matrix.test", "Alpha Stores");
    b = await shop(h.http, "owner-b@matrix.test", "Bravotenant Stores");
    ids.branch = b.branchId;
    ids.business = b.businessId;
    const bt = b.token;
    ids.product = await product(h.http, bt, "Zebrarice 50kg", "7500000");
    ids.customer = await customer(h.http, bt, "Okonkwo Bravo", "08035550000");
    ids.followup = (await request(h.http).post(`/api/v1/customers/${ids.customer}/followups`).set(auth(bt)).send({ title: "Call Okonkwo Bravo", dueAt: new Date(Date.now() + 86_400_000).toISOString() })).body.data?.followup?.id ?? randomUUID();
    await request(h.http).post(`/api/v1/customers/${ids.customer}/notes`).set(auth(bt)).send({ body: "Bravotenant note" });
    const sale = await request(h.http).post("/api/v1/sales").set(auth(bt)).send({ customerId: ids.customer, lines: [{ productId: ids.product, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "5000000" }], dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), comment: "Bravotenant credit" });
    if (sale.status !== 201) throw new Error(JSON.stringify(sale.body));
    ids.sale = sale.body.data.sale.id;
    ids.payment = (await request(h.http).post(`/api/v1/debtors/${ids.customer}/payments`).set(auth(bt)).send({ amountMinor: "1000000", method: "cash" }).expect(201)).body.data.payment.id;
    ids.supplier = (await request(h.http).post("/api/v1/suppliers").set(auth(bt)).send({ name: "Bravo Supplies", phone: "08036660000" }).expect(201)).body.data.supplier.id;
    const job = await request(h.http).post("/api/v1/jobs").set(auth(bt)).send({ customerId: ids.customer, title: "Bravo job: Camry brakes", problem: "Bravotenant brakes" });
    ids.job = job.body.data?.job?.id ?? randomUUID();
    if (job.status === 201) {
      const lined = await request(h.http).post(`/api/v1/jobs/${ids.job}/lines`).set(auth(bt)).send({ kind: "work", description: "Bravotenant labour", quantity: "1", unitPriceMinor: "500000" });
      ids.jobLine = lined.body.data?.job?.lines?.[0]?.id ?? randomUUID();
    } else ids.jobLine = randomUUID();
    const categories = (await request(h.http).get("/api/v1/money/expenses/categories").set(auth(bt))).body.data?.items ?? [];
    ids.expense = (await request(h.http).post("/api/v1/money/expenses").set(auth(bt)).send({ id: uuidv7(), categoryId: categories[0]?.id, amountMinor: "150000", paidFrom: "cash", payee: "Bravotenant okada" })).body.data?.expense?.id ?? randomUUID();
    ids.movement = (await request(h.http).post("/api/v1/money/movements").set(auth(bt)).send({ kind: "other_in", amountMinor: "100000", note: "Bravotenant loan" })).body.data?.movement?.id ?? randomUUID();
    ids.count = (await request(h.http).post("/api/v1/stock/counts").set(auth(bt)).send({ productId: ids.product, countedQuantity: "7", unit: "bag", note: "Bravotenant count" })).body.data?.count?.id ?? randomUUID();
    ids.invitation = (await request(h.http).post("/api/v1/invitations").set(auth(bt)).send({ email: "pending-bravo@matrix.test", role: "SALES", businessId: b.businessId, branchId: b.branchId }).expect(201)).body.data.invitation.id;
    await staff(h.http, b, "bravo-cashier@matrix.test", "CASHIER");
    const members = await h.client.query<{ id: string }>("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'bravo-cashier@matrix.test'");
    ids.membership = members.rows[0]!.id;
    await request(h.http).patch(`/api/v1/businesses/${b.businessId}`).set(auth(bt)).send({ salesItems: "both" }).expect(200);
    await request(h.http).post("/api/v1/sales").set(auth(bt)).send({ lines: [{ description: "Bravotenant bread", quantity: "1", unitPriceMinor: "150000", saved: true }], payments: [{ method: "cash", amountMinor: "150000" }] }).expect(201);
    ids.savedItem = (await request(h.http).get("/api/v1/saved-items").set(auth(bt))).body.data.items[0].id;
    ids.unit = (await request(h.http).post("/api/v1/units").set(auth(bt)).send({ code: "cup", displayName: "Bravotenant cup" }).expect(201)).body.data.unit.id;
    ids.tenant = b.tenantId;
    ids.user = b.userId;
    // Catalog, transfers, counts, price lists and deliveries (the routes added after the first matrix).
    ids.category = (await request(h.http).post("/api/v1/catalog/categories").set(auth(bt)).send({ name: "Bravotenant grains" }).expect(201)).body.data.category.id;
    ids.brand = (await request(h.http).post("/api/v1/catalog/brands").set(auth(bt)).send({ name: "Bravotenant Mills" }).expect(201)).body.data.brand.id;
    // ADR-060: an attribute with a choice, set on B's product.
    const attribute = (await request(h.http).post("/api/v1/catalog/attributes").set(auth(bt)).send({ name: "Bravotenant colour", options: ["Bravotenant red"] }).expect(201)).body.data.attribute;
    ids.attribute = attribute.id;
    await request(h.http).put(`/api/v1/catalog/products/${ids.product}/attributes`).set(auth(bt)).send({ values: [{ attributeId: attribute.id, optionIds: [attribute.options[0].id] }] }).expect(200);
    ids.item = (await request(h.http).post("/api/v1/catalog/items").set(auth(bt)).send({ name: "Bravotenant oil", categoryId: ids.category, brandId: ids.brand, variants: [{ baseUnit: "bottle", priceMinor: "100000" }] }).expect(201)).body.data.item.id;
    ids.warehouse = (await request(h.http).post("/api/v1/branches").set(auth(bt)).send({ name: "Bravotenant store", kind: "warehouse" }).expect(201)).body.data.branch.id;
    ids.transfer = (await request(h.http).post("/api/v1/inventory/transfers").set(auth(bt)).send({ toBranchId: ids.warehouse, lines: [{ productId: ids.product, quantity: "1", unit: "bag" }] }).expect(201)).body.data.transfer.id;
    ids.countSession = (await request(h.http).post("/api/v1/inventory/counts").set(auth(bt)).send({ name: "Bravotenant session" }).expect(201)).body.data.count.id;
    ids.priceList = (await request(h.http).post("/api/v1/pricing/lists").set(auth(bt)).send({ name: "Bravotenant prices" }).expect(201)).body.data.id;
    await request(h.http).put(`/api/v1/pricing/lists/${ids.priceList}/prices`).set(auth(bt)).send({ prices: [{ productId: ids.product, unitCode: "bag", priceMinor: "7000000" }] }).expect(200);
    ids.price = (await request(h.http).get(`/api/v1/pricing/lists/${ids.priceList}/prices`).set(auth(bt)).expect(200)).body.data.prices[0].id;
    ids.receipt = (await request(h.http).post("/api/v1/stock/receipts").set(auth(bt)).send({ branchId: ids.warehouse, supplierId: ids.supplier, paidFrom: "credit", paidFromBranchId: b.branchId, lines: [{ productId: ids.product, quantity: "1", unit: "bag", totalCostMinor: "100000" }], charges: [{ kind: "transport", amountMinor: "1000", paidFrom: "cash" }] }).expect(201)).body.data.id;
    await request(h.http).put(`/api/v1/suppliers/${ids.supplier}/products`).set(auth(bt)).send({ productId: ids.product, supplierSku: "BRAVO-RICE" }).expect(200);
    const missed = await request(h.http)
      .post("/api/v1/sync/push")
      .set(auth(bt))
      .send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), lines: [{ productId: randomUUID(), quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "100" }], soldAt: new Date().toISOString() } }] })
      .expect(200);
    if (missed.body.data.results[0].status !== "rejected" || missed.body.data.results[0].stored !== true) throw new Error(JSON.stringify(missed.body));
    ids.problem = (await h.client.query<{ id: string }>("SELECT id FROM sync_problems WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [b.tenantId])).rows[0]!.id;
    // A has its own records too, so lists are not empty for the wrong reason.
    await product(h.http, a.token, "Alpha beans", "4000000");
    before = await fingerprint(b.tenantId);
  }, 120_000);

  afterAll(async () => h.close());

  it("has real records in B for the main kinds", () => {
    for (const kind of ["product", "customer", "sale", "payment", "supplier", "invitation", "membership", "savedItem"]) expect(ids[kind], kind).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses every route with an id when it points at B, and leaks nothing", async () => {
    const failures: string[] = [];
    for (const route of (await routes()).filter((item) => item.path.includes(":"))) {
      const url = route.path.replace(/:([A-Za-z]+)/g, (_, param: string) => idFor(route.path, param));
      const call = request(h.http)[route.method as "get" | "post" | "patch" | "put" | "delete"](url).set(auth(a.token)).set("idempotency-key", randomUUID());
      const response = route.method === "get" || route.method === "delete" ? await call : await call.send(BODIES[`${route.method.toUpperCase()} ${route.path}`] ?? BODY);
      const admin = route.path.startsWith("/api/admin/");
      // A business sign-in is not an Admin portal sign-in: 401 when the portal is on, 404 when it is not.
      const allowed = route.method === "get" ? (admin ? [401, 403, 404] : [403, 404]) : admin ? [400, 401, 403, 404, 409, 422] : [400, 403, 404, 409, 422];
      const leaked = leaks(JSON.stringify(response.body ?? "") + (response.text ?? ""));
      if (process.env.MATRIX_DEBUG) console.log("PROBE", response.status, route.method.toUpperCase(), route.path);
      if (!allowed.includes(response.status) || leaked.length) failures.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}${leaked.length ? ` leaked ${leaked.join(", ")}` : ""}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("never lists B's records in any of A's lists", async () => {
    const failures: string[] = [];
    for (const route of (await routes()).filter((item) => item.method === "get" && !item.path.includes(":"))) {
      const response = await request(h.http).get(route.path).set(auth(a.token));
      const leaked = leaks(JSON.stringify(response.body ?? "") + (response.text ?? ""));
      if (leaked.length) failures.push(`GET ${route.path} leaked ${leaked.join(", ")}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("refuses creating A's records that point at B's", async () => {
    const tries: [string, string, object][] = [
      ["post", "/api/v1/sales", { lines: [{ productId: ids.product, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] }],
      ["post", "/api/v1/sales", { customerId: ids.customer, lines: [{ description: "Probe", quantity: "1", unitPriceMinor: "100" }], payments: [], dueDate: "2099-01-01", comment: "x" }],
      ["post", "/api/v1/stock/adjust", { productId: ids.product, direction: "remove", reason: "damaged", quantity: "1", unit: "bag", note: "x" }],
      ["post", "/api/v1/stock/receive", { productId: ids.product, quantity: "1", unit: "bag", totalCostMinor: "100", paidFrom: "cash" }],
      ["post", "/api/v1/stock/counts", { productId: ids.product, countedQuantity: "1", unit: "bag", note: "x" }],
      ["post", "/api/v1/stock/transfer", { productId: ids.product, quantity: "1", unit: "bag", toBranchId: b.branchId }],
      ["post", "/api/v1/stock/return-to-supplier", { supplierId: ids.supplier, productId: ids.product, quantity: "1", unit: "bag", settle: "owed" }],
      ["post", "/api/v1/jobs", { customerId: ids.customer, title: "Probe", problem: "x" }],
      ["post", "/api/v1/work-permits", { membershipId: ids.membership, until: new Date(Date.now() + 3_600_000).toISOString() }],
      ["post", "/api/v1/invitations", { email: "probe@a.test", role: "CASHIER", businessId: b.businessId, branchId: b.branchId }],
      ["post", "/api/v1/money/expenses", { id: uuidv7(), amountMinor: "100", paidFrom: "cash", payee: "x", branchId: b.branchId }],
      ["post", "/api/v1/money/pos-cashouts", { amountMinor: "100", feeMinor: "0", feePaidBy: "pos", branchId: b.branchId }],
      // The server records the event on the signed-in business, never on a tenant id from the body.
      ["post", "/api/v1/telemetry/events", { events: [{ name: "voice.review_shown", detail: "probe" }] }],
      ["post", "/api/v1/stock/receipts", { branchId: ids.warehouse, supplierId: ids.supplier, paidFrom: "credit", lines: [{ productId: ids.product, quantity: "1", unit: "bag", totalCostMinor: "100" }], charges: [{ kind: "transport", amountMinor: "10", paidFrom: "cash" }] }],
      ["post", "/api/v1/inventory/transfers", { fromBranchId: b.branchId, toBranchId: ids.warehouse, lines: [{ productId: ids.product, quantity: "1", unit: "bag" }] }],
      ["post", "/api/v1/inventory/counts", { branchId: b.branchId, name: "Probe count" }],
      ["post", "/api/v1/pricing/lists", { name: "Probe prices" }],
      ["put", "/api/v1/customers/" + ids.customer + "/price-list", { priceListId: ids.priceList }],
      ["put", "/api/v1/suppliers/" + ids.supplier + "/products", { productId: ids.product, supplierSku: "PROBE" }],
      // A report for B's shop (ADR-058).
      ["get", `/api/v1/sales/report?branchId=${b.branchId}`, {}],
      ["get", `/api/v1/sales/report.csv?branchId=${b.branchId}`, {}],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of tries) {
      const response = await request(h.http)[method as "post"](path).set(auth(a.token)).set("idempotency-key", randomUUID()).send(body);
      if (response.status < 400) {
        // Only acceptable if what was made belongs to A and names nothing of B's.
        const text = JSON.stringify(response.body);
        if (leaks(text).length || text.includes(b.branchId) || text.includes(b.businessId)) failures.push(`${path} → ${response.status} using B's records`);
      }
    }
    expect(failures).toEqual([]);
    // Offline sync is checked the same way: the sale names B's product and is refused.
    const pushed = await request(h.http)
      .post("/api/v1/sync/push")
      .set(auth(a.token))
      .send({ operations: [{ id: uuidv7(), type: "sale.create", occurredAt: new Date().toISOString(), payload: { id: uuidv7(), lines: [{ productId: ids.product, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }], soldAt: new Date().toISOString() } }] })
      .expect(200);
    expect(pushed.body.data.results[0].status).toBe("rejected");
  }, 120_000);

  it("left every one of B's rows exactly as it was", async () => {
    expect(await fingerprint(b.tenantId)).toEqual(before);
  });

  it("knows every route that takes an id (a new one must be added to this matrix)", async () => {
    const missing: string[] = [];
    for (const route of (await routes()).filter((item) => item.path.includes(":"))) {
      for (const [, param] of route.path.matchAll(/:([A-Za-z]+)/g)) {
        try {
          idFor(route.path, param!);
        } catch {
          missing.push(`${route.method.toUpperCase()} ${route.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
