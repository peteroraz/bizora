/**
 * Pilot calls baseline (pilot paperwork, Task 10.5): the calls a pilot business makes that the first baseline did not
 * time on their own: sign-in, product search, stock lookup, reports, a business with several shops, and a long
 * product list.
 *
 *   node --experimental-strip-types scripts/perf-pilot-calls.ts http://localhost:3001 [--shops 5] [--products 2000] [--sales 2000] [--runs 20]
 *
 * 1. Signs up a business with the given number of shops, products (through the product import) and sales spread over
 *    the shops.
 * 2. Times each call one at a time, `--runs` times: median, 95th percentile, slowest. No other load.
 *
 * Never point it at production: it creates a business full of made-up records.
 */
type Sample = { name: string; ms: number; ok: boolean };

const args = process.argv.slice(2);
const base = (args.find((value) => value.startsWith("http")) ?? "http://localhost:3001").replace(/\/$/, "");
const option = (name: string, fallback: number) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const SHOPS = option("--shops", 5);
const PRODUCTS = option("--products", 2000);
const SALES = option("--sales", 2000);
const RUNS = option("--runs", 20);
if (/bizora\.app|production/i.test(base) && !args.includes("--i-know-this-is-not-production")) throw new Error("Refusing: this looks like production.");

const PASSWORD = "LocalOnly!Passw0rd";
let token = "";
async function call(method: string, path: string, body?: unknown, auth: boolean | string = true) {
  const started = performance.now();
  const bearer = typeof auth === "string" ? auth : token;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { ms: performance.now() - started, ok: response.ok, status: response.status, json: () => JSON.parse(text) as { data: Record<string, unknown> } };
}

async function inBatches(count: number, parallel: number, work: (index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) await work(next++);
    }),
  );
}

function table(samples: Sample[]) {
  const names = [...new Set(samples.map((sample) => sample.name))];
  const lines = ["| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |", "| --- | --- | --- | --- | --- | --- |"];
  for (const name of names) {
    const times = samples.filter((sample) => sample.name === name).map((sample) => sample.ms).sort((a, b) => a - b);
    const errors = samples.filter((sample) => sample.name === name && !sample.ok).length;
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    lines.push(`| ${name} | ${times.length} | ${at(0.5).toFixed(0)} | ${at(0.95).toFixed(0)} | ${(times.at(-1) ?? 0).toFixed(0)} | ${errors} |`);
  }
  return lines.join("\n");
}

async function main() {
  const stamp = Date.now();
  const email = `pilot-calls-${stamp}@bizora.test`;
  const registered = await call(
    "POST",
    "/api/v1/auth/register",
    { email, password: PASSWORD, displayName: "Pilot Owner", organizationName: `Pilot Calls ${stamp}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true },
    false,
  );
  if (!registered.ok) throw new Error(`Sign-up failed: ${registered.status}`);
  const data = registered.json().data as { accessToken: string; tenant: { tenantId: string; businessId: string; branchId: string } };
  token = data.accessToken;
  await call("PATCH", "/api/v1/onboarding", { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Pilot Calls", branchName: "Main" });
  const shops = [data.tenant.branchId];
  for (let index = 1; index < SHOPS; index += 1) {
    const made = await call("POST", "/api/v1/branches", { name: `Shop ${index + 1}`, businessId: data.tenant.businessId });
    if (!made.ok) throw new Error(`Shop failed: ${made.status}`);
    shops.push(String((made.json().data.branch as { id: string }).id));
  }
  // A token per shop, as the app has after choosing a shop at the top of the screen.
  const organizationId = data.tenant.tenantId;
  const shopTokens: string[] = [];
  // One sign-in per shop: choosing a shop replaces the session's token, so each shop needs its own session.
  for (const shop of shops) {
    const signed = await call("POST", "/api/v1/auth/login", { email, password: PASSWORD }, false);
    if (!signed.ok) throw new Error(`Sign-in failed: ${signed.status}`);
    const sessionToken = String((signed.json().data as { accessToken: string }).accessToken);
    const chosen = await call("POST", "/api/v1/auth/select-context", { organizationId, businessId: data.tenant.businessId, branchId: shop }, sessionToken);
    if (!chosen.ok) throw new Error(`Choosing a shop failed: ${chosen.status}`);
    shopTokens.push(String((chosen.json().data as { accessToken: string }).accessToken));
  }
  token = shopTokens[0]!;

  const started = performance.now();
  for (let start = 0; start < PRODUCTS; start += 2000) {
    const rows = Array.from({ length: Math.min(2000, PRODUCTS - start) }, (_, offset) => {
      const index = start + offset;
      return { name: `Item ${String(index).padStart(5, "0")} ${["Rice", "Beans", "Milk", "Soap", "Oil"][index % 5]}`, unit: "piece", price: String(200 + (index % 50) * 10), quantity: "500" };
    });
    const saved = await call("POST", "/api/v1/imports/products", { dryRun: false, rows });
    if (!saved.ok) throw new Error(`Import failed: ${saved.status}`);
  }
  const products = (await call("GET", "/api/v1/products?q=Rice")).json().data.items as { id: string; priceMinor: string }[];
  // Stock in every other shop too, then sales spread over the shops.
  for (const shop of shops.slice(1)) {
    await inBatches(Math.min(products.length, 20), 5, async (index) => {
      const product = products[index]!;
      await call("POST", "/api/v1/stock/receive", { productId: product.id, branchId: shop, quantity: "1000", unit: "piece", paidFrom: "cash", totalCostMinor: "10000000" });
    });
  }
  await inBatches(SALES, 10, async (index) => {
    const product = products[index % Math.min(products.length, 20)]!;
    await call("POST", "/api/v1/sales", { lines: [{ productId: product.id, quantity: "1", unit: "piece" }], payments: [{ method: index % 2 ? "cash" : "transfer", amountMinor: product.priceMinor }] }, shopTokens[index % shopTokens.length]);
  });
  const filled = (performance.now() - started) / 1000;

  const samples: Sample[] = [];
  const time = async (name: string, method: string, path: string, body?: unknown, auth = true) => {
    const result = await call(method, path, body, auth);
    samples.push({ name, ms: result.ms, ok: result.ok });
  };
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  for (let run = 0; run < RUNS; run += 1) {
    await time("Sign in (email and password)", "POST", "/api/v1/auth/login", { email, password: PASSWORD }, false);
    await time("Product search", "GET", "/api/v1/products?q=beans");
    await time("Product list, a later page", "GET", `/api/v1/products?page=${2 + (run % 10)}`);
    await time("Stock lookup (one product, all shops)", "GET", `/api/v1/products/${products[run % products.length]!.id}`);
    await time("Low stock", "GET", "/api/v1/stock/low");
    await time("Sales summary (today)", "GET", "/api/v1/sales/summary");
    await time("Top items", "GET", "/api/v1/sales/top-items");
    await time("Profit for the month", "GET", `/api/v1/money/profit?from=${month}-01&to=${today}`);
    await time("Dashboard", "GET", "/api/v1/dashboard");
    await time(`Today's sales, one shop of ${shops.length}`, "GET", "/api/v1/sales", undefined, shopTokens[1 % shopTokens.length]);
    await time(`Low stock, one shop of ${shops.length}`, "GET", "/api/v1/stock/low", undefined, shopTokens[1 % shopTokens.length]);
  }
  console.log(`\nFilled ${SHOPS} shops, ${PRODUCTS.toLocaleString("en")} products and ${SALES.toLocaleString("en")} sales in ${filled.toFixed(0)} s.\n`);
  console.log(table(samples));
}

await main();
