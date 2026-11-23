/**
 * Performance baseline (pilot readiness, item 28).
 *
 *   node --experimental-strip-types scripts/perf-baseline.ts http://localhost:3001 [--customers 5000] [--sales 10000] [--seconds 30]
 *
 * 1. Signs up a new business and fills it: 20 products, 5,000 customers, 10,000 sales (a third to a named customer).
 * 2. Runs 20, then 50, simulated people at once for the given seconds. Each repeats what a shop does all day:
 *    - open the home screen (its 6 main calls);
 *    - list today's sales;
 *    - search customers;
 *    - list debtors;
 *    - record a sale (1 time in 8).
 * 3. Prints the latency of each call (median, 95th percentile, slowest) and errors, as a Markdown table.
 *
 * Never point it at production: it creates a business full of made-up records. Staging, or a local API, only.
 */
type Sample = { name: string; ms: number; ok: boolean };

const args = process.argv.slice(2);
const base = (args.find((value) => value.startsWith("http")) ?? "http://localhost:3001").replace(/\/$/, "");
const option = (name: string, fallback: number) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const CUSTOMERS = option("--customers", 5000);
const SALES = option("--sales", 10000);
const SECONDS = option("--seconds", 30);
if (/bizora\.app|production/i.test(base) && !args.includes("--i-know-this-is-not-production")) throw new Error("Refusing: this looks like production.");

let token = "";
async function call(method: string, path: string, body?: unknown) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { ms: performance.now() - started, ok: response.ok, status: response.status, json: () => JSON.parse(text) as { data: Record<string, unknown> } };
}

async function inBatches<T>(count: number, parallel: number, work: (index: number) => Promise<T>) {
  let next = 0;
  const results: T[] = [];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await work(index);
      }
    }),
  );
  return results;
}

function stats(samples: Sample[]) {
  const names = [...new Set(samples.map((sample) => sample.name))];
  return names.map((name) => {
    const times = samples.filter((sample) => sample.name === name).map((sample) => sample.ms).sort((a, b) => a - b);
    const errors = samples.filter((sample) => sample.name === name && !sample.ok).length;
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    return { name, count: times.length, p50: at(0.5), p95: at(0.95), max: times.at(-1) ?? 0, errors };
  });
}

async function main() {
  const stamp = Date.now();
  const registered = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `perf-${stamp}@bizora.test`, password: "LocalOnly!Passw0rd", displayName: "Perf Owner", organizationName: `Perf Shop ${stamp}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true }),
  });
  if (!registered.ok) throw new Error(`Sign-up failed: ${registered.status} ${await registered.text()}`);
  token = String(((await registered.json()) as { data: { accessToken: string } }).data.accessToken);

  const fillStarted = performance.now();
  const products = await inBatches(20, 5, async (index) => {
    const made = await call("POST", "/api/v1/products", { name: `Product ${index + 1}`, baseUnit: "piece", priceMinor: String(50_000 + index * 2_500), openingQuantity: "1000000", openingCostMinor: String(30_000 * 1_000_000) });
    if (!made.ok) throw new Error(`Product failed: ${made.status}`);
    return String((made.json().data.product as { id: string }).id);
  });
  const customers = await inBatches(CUSTOMERS, 10, async (index) => {
    const made = await call("POST", "/api/v1/customers", { name: `Customer ${index + 1}`, phone: `0803${String(1_000_000 + index).padStart(7, "0")}` });
    if (!made.ok) throw new Error(`Customer ${index} failed: ${made.status}`);
    return String((made.json().data.customer as { id: string }).id);
  });
  const fillSales: Sample[] = [];
  await inBatches(SALES, 10, async (index) => {
    const product = products[index % products.length]!;
    const price = BigInt(50_000 + (index % products.length) * 2_500);
    const quantity = (index % 3) + 1;
    const made = await call("POST", "/api/v1/sales", {
      ...(index % 3 === 0 ? { customerId: customers[index % customers.length] } : {}),
      lines: [{ productId: product, quantity: String(quantity), unit: "piece" }],
      payments: [{ method: index % 2 ? "transfer" : "cash", amountMinor: (price * BigInt(quantity)).toString() }],
    });
    fillSales.push({ name: "record a sale (filling)", ms: made.ms, ok: made.ok });
    if (!made.ok && fillSales.filter((sample) => !sample.ok).length > 20) throw new Error(`Too many failed sales; last ${made.status}`);
  });
  const fillSeconds = (performance.now() - fillStarted) / 1000;

  const rounds: { people: number; samples: Sample[]; seconds: number }[] = [];
  for (const people of [20, 50]) {
    const samples: Sample[] = [];
    const until = performance.now() + SECONDS * 1000;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: people }, async (_, person) => {
        let turn = 0;
        while (performance.now() < until) {
          turn += 1;
          const step = turn % 5;
          if (step === 0) {
            const home = ["/api/v1/dashboard", "/api/v1/sales/summary", "/api/v1/money/cash", "/api/v1/money/profit", "/api/v1/debtors", "/api/v1/stock/low"];
            const results = await Promise.all(home.map((path) => call("GET", path)));
            samples.push({ name: "home screen (6 calls together)", ms: Math.max(...results.map((result) => result.ms)), ok: results.every((result) => result.ok) });
          } else if (step === 1) {
            const listed = await call("GET", "/api/v1/sales?page=1");
            samples.push({ name: "list sales", ms: listed.ms, ok: listed.ok });
          } else if (step === 2) {
            const found = await call("GET", `/api/v1/customers?q=${encodeURIComponent(`Customer ${(person * 37 + turn) % CUSTOMERS}`)}`);
            samples.push({ name: "search customers", ms: found.ms, ok: found.ok });
          } else if (step === 3) {
            const debtors = await call("GET", "/api/v1/debtors");
            samples.push({ name: "list debtors", ms: debtors.ms, ok: debtors.ok });
          } else if (turn % 8 === 4) {
            const product = products[turn % products.length]!;
            const sold = await call("POST", "/api/v1/sales", { lines: [{ productId: product, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: String(50_000 + (turn % products.length) * 2_500) }] });
            samples.push({ name: "record a sale", ms: sold.ms, ok: sold.ok });
          }
        }
      }),
    );
    rounds.push({ people, samples, seconds: (performance.now() - started) / 1000 });
  }

  const row = (item: ReturnType<typeof stats>[number]) => `| ${item.name} | ${item.count} | ${Math.round(item.p50)} | ${Math.round(item.p95)} | ${Math.round(item.max)} | ${item.errors} |`;
  console.log(`# Performance baseline\n\nAPI: ${base}\nWhen: ${new Date().toISOString()}\nNode: ${process.version}\n`);
  console.log(`Filled a business with ${products.length} products, ${customers.length} customers and ${SALES} sales in ${fillSeconds.toFixed(0)} s.\n`);
  console.log("| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |\n| --- | --- | --- | --- | --- | --- |");
  for (const item of stats(fillSales)) console.log(row(item));
  for (const round of rounds) {
    const done = round.samples.length;
    console.log(`\n## ${round.people} people at once, ${round.seconds.toFixed(0)} s (${(done / round.seconds).toFixed(1)} actions a second)\n`);
    console.log("| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |\n| --- | --- | --- | --- | --- | --- |");
    for (const item of stats(round.samples)) console.log(row(item));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
