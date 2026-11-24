/**
 * Catalog size check (inventory phase 6, item 5; ADR-067).
 *
 *   node --experimental-strip-types scripts/perf-catalog.ts http://localhost:3001 [--sizes 1000,10000,50000] [--runs 20]
 *
 * Signs up one new business and fills it, through the product import, to each size in turn. At each size it
 * measures, one call at a time (no other load), the calls a shop makes against a big catalog:
 *   - product search: a common word, a rare word, part of a word, and one product's number;
 *   - the product list, first page;
 *   - stock lookup: one product's page;
 *   - recording a sale of two products;
 *   - a line of a stock count;
 *   - the sales summary and top items;
 *   - the phone's full product download (all pages), with its size.
 * Prints a Markdown table per size: median, 95th percentile and slowest, in milliseconds.
 *
 * Never point it at production: it creates a business with tens of thousands of made-up products.
 */
type Sample = { name: string; ms: number; ok: boolean };

const args = process.argv.slice(2);
const base = (args.find((value) => value.startsWith("http")) ?? "http://localhost:3001").replace(/\/$/, "");
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const SIZES = option("--sizes", "1000,10000,50000").split(",").map(Number);
const RUNS = Number(option("--runs", "20"));
const BATCH = 2000;
if (/bizora\.app|production/i.test(base) && !args.includes("--i-know-this-is-not-production")) throw new Error("Refusing: this looks like production.");

const WORDS = ["Rice", "Beans", "Garri", "Semovita", "Milk", "Sugar", "Indomie", "Spaghetti", "Tomato", "Oil", "Soap", "Detergent", "Biscuit", "Juice", "Water", "Salt", "Pepper", "Yam flour", "Cornflakes", "Tea"];
const BRANDS = ["Dangote", "Golden Penny", "Peak", "Dano", "Honeywell", "Mama Gold", "Power", "Kings", "Devon", "Gino"];
const SIZE_WORDS = ["50g", "100g", "250g", "400g", "500g", "1kg", "2kg", "5kg", "10kg", "50kg", "35cl", "50cl", "75cl", "1L", "2L", "5L"];

let token = "";
async function call(method: string, path: string, body?: unknown) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { ms: performance.now() - started, ok: response.ok, status: response.status, bytes: text.length, json: () => JSON.parse(text) as { data: Record<string, unknown> } };
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

/** Product number `index`, with a name like real shelves: "Dangote Rice 50kg 0001234". */
function productRow(index: number) {
  const word = WORDS[index % WORDS.length]!;
  const brand = BRANDS[Math.floor(index / WORDS.length) % BRANDS.length]!;
  const size = SIZE_WORDS[Math.floor(index / (WORDS.length * BRANDS.length)) % SIZE_WORDS.length]!;
  return {
    name: `${brand} ${word} ${size} ${String(index).padStart(7, "0")}`,
    category: `Provisions > ${word}`,
    unit: "piece",
    price: String(100 + (index % 900) * 10),
    quantity: "100",
  };
}

async function fillTo(target: number, have: number) {
  const started = performance.now();
  for (let start = have; start < target; start += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, target - start) }, (_, offset) => productRow(start + offset));
    const saved = await call("POST", "/api/v1/imports/products", { dryRun: false, rows });
    if (!saved.ok) throw new Error(`Import failed at ${start}: ${saved.status}`);
    process.stderr.write(`  ${start + rows.length} products\n`);
  }
  return performance.now() - started;
}

async function measure(size: number) {
  const samples: Sample[] = [];
  const time = async (name: string, method: string, path: string, body?: unknown) => {
    const result = await call(method, path, body);
    samples.push({ name, ms: result.ms, ok: result.ok });
    return result;
  };
  const list = (await call("GET", "/api/v1/products?q=Rice")).json().data.items as { id: string; priceMinor: string }[];
  const [first, second] = list;
  if (!first || !second) throw new Error("No products found to sell.");
  const total = (BigInt(first.priceMinor) + BigInt(second.priceMinor)).toString();
  const count = (await call("POST", "/api/v1/inventory/counts", { name: `Count at ${size}` })).json().data.count as { id: string };
  for (let run = 0; run < RUNS; run += 1) {
    await time("Search: a common word (\"rice\")", "GET", "/api/v1/products?q=rice");
    await time("Search: a rare word (\"cornflakes 2kg\")", "GET", `/api/v1/products?q=${encodeURIComponent("cornflakes 2kg")}`);
    await time("Search: part of a word (\"semov\")", "GET", "/api/v1/products?q=semov");
    await time("Search: one product's number", "GET", `/api/v1/products?q=${String(Math.floor(size / 2) + run).padStart(7, "0")}`);
    await time("Product list, first page", "GET", "/api/v1/products");
    await time("Stock lookup (one product)", "GET", `/api/v1/products/${first.id}`);
    await time("Record a sale (2 products)", "POST", "/api/v1/sales", {
      lines: [
        { productId: first.id, quantity: "1", unit: "piece" },
        { productId: second.id, quantity: "1", unit: "piece" },
      ],
      payments: [{ method: "cash", amountMinor: total }],
    });
    await time("Count a product", "POST", `/api/v1/inventory/counts/${count.id}/lines`, { productId: first.id, countedQuantity: String(90 - run), unit: "piece" });
    await time("Sales summary", "GET", "/api/v1/sales/summary");
    await time("Top items", "GET", "/api/v1/sales/top-items");
  }
  // The phone downloads every product to sell offline: all pages, as the app does.
  let download = 0;
  let bytes = 0;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    let products: string | null = null;
    let balances: string | null = null;
    bytes = 0;
    for (let page = 0; page < 200; page += 1) {
      const query = new URLSearchParams();
      if (products) query.set("products", products);
      if (balances) query.set("balances", balances);
      const result = await call("GET", `/api/v1/products/sync?${query.toString()}`);
      bytes += result.bytes;
      const data = result.json().data as { cursors: { products: string | null; balances: string | null }; done: boolean };
      products = data.cursors.products;
      balances = data.cursors.balances;
      if (data.done) break;
    }
    download = round === 0 ? performance.now() - started : Math.min(download, performance.now() - started);
  }
  return { rows: stats(samples), download, bytes };
}

async function main() {
  const stamp = Date.now();
  // --email: measure an existing business again, without filling what is already there.
  const email = option("--email", "");
  if (email) {
    const signed = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "LocalOnly!Passw0rd" }) });
    if (!signed.ok) throw new Error(`Sign-in failed: ${signed.status}`);
    token = String(((await signed.json()) as { data: { accessToken: string } }).data.accessToken);
    let have = Number((await call("GET", "/api/v1/products")).json().data.total ?? 0);
    for (const size of SIZES) {
      if (size > have) {
        await fillTo(size, have);
        have = size;
      }
      await report(size, 0);
    }
    return;
  }
  const registered = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `catalog-${stamp}@bizora.test`, password: "LocalOnly!Passw0rd", displayName: "Catalog Owner", organizationName: `Catalog Shop ${stamp}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true }),
  });
  if (!registered.ok) throw new Error(`Sign-up failed: ${registered.status} ${await registered.text()}`);
  token = String(((await registered.json()) as { data: { accessToken: string } }).data.accessToken);
  await call("PATCH", "/api/v1/onboarding", { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Catalog Shop", branchName: "Main" });

  let have = 0;
  for (const size of SIZES) {
    const fill = await fillTo(size, have);
    have = size;
    await report(size, fill);
  }
}

async function report(size: number, fill: number) {
  const result = await measure(size);
  console.log(`\n### ${size.toLocaleString("en")} products\n`);
  if (fill) console.log(`Filling to this size through the product import took ${(fill / 1000).toFixed(0)} s.\n`);
  console.log("| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const row of result.rows) console.log(`| ${row.name} | ${row.count} | ${row.p50.toFixed(0)} | ${row.p95.toFixed(0)} | ${row.max.toFixed(0)} | ${row.errors} |`);
  console.log(`\nThe phone's full product download: ${(result.download / 1000).toFixed(1)} s, ${(result.bytes / 1024 / 1024).toFixed(1)} MB before compression.`);
}

await main();
