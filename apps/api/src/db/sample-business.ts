import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadEnv, socketDirFromEnv } from "@bizora/config/env";
import { sql as sqlTag } from "drizzle-orm";
import postgres from "postgres";
import { createApp } from "../bootstrap.js";
import { createLogger } from "../logging.js";
import { createPostgresDatabase } from "./database.js";

/**
 * A sample business for demonstrations and training (ADR-045).
 *
 *   sample-business create [--email you@example.com]   makes one through the API itself, so its books are real books
 *   sample-business list                                 lists sample businesses
 *   sample-business remove --yes                         removes every sample business and its people, nothing else
 *
 * A sample business is marked (organizations.is_sample) and shown as "Sample" in the app and the Admin portal, and is
 * left out of pilot totals. The sign-in password is made at random and printed once; it is never stored here.
 */
const PRODUCTS = [
  { name: "Rice 50kg (sample)", baseUnit: "bag", priceMinor: "7800000", openingQuantity: "20", openingCostMinor: "136000000" },
  { name: "Garri 1 paint (sample)", baseUnit: "paint", priceMinor: "250000", openingQuantity: "40", openingCostMinor: "8000000" },
  { name: "Palm oil 4L (sample)", baseUnit: "bottle", priceMinor: "900000", openingQuantity: "15", openingCostMinor: "11250000" },
  { name: "Noodles carton (sample)", baseUnit: "carton", priceMinor: "1150000", openingQuantity: "25", openingCostMinor: "25000000" },
];
const CUSTOMERS = [
  { name: "Sample Customer Ada", phone: "08030000001" },
  { name: "Sample Customer Musa", phone: "08030000002" },
  { name: "Sample Customer Ngozi", phone: "08030000003" },
];

async function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  const env = loadEnv();
  if (command === "create") return create({ ...env, EMAIL_PROVIDER: "console" }, option(rest, "--email"));
  const sql = postgres(env.DATABASE_URL, { max: 1, ...(socketDirFromEnv(env.DATABASE_SOCKET_DIR) ? { host: socketDirFromEnv(env.DATABASE_SOCKET_DIR)! } : {}) });
  try {
    if (command === "list") {
      const rows = await sql`SELECT id, name, created_at FROM organizations WHERE is_sample ORDER BY created_at`;
      for (const row of rows) console.log(`${row.id}  ${row.name}  ${new Date(row.created_at as string).toISOString()}`);
      if (rows.length === 0) console.log("No sample businesses.");
      return;
    }
    if (command === "remove") {
      if (!rest.includes("--yes")) throw new Error("This removes every sample business. Run again with --yes.");
      await removeSamples(sql);
      return;
    }
    throw new Error("Use: sample-business create [--email you@example.com] | list | remove --yes");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function option(args: string[], name: string) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function create(env: ReturnType<typeof loadEnv>, email?: string) {
  const logger = createLogger("error");
  const { db, client } = createPostgresDatabase(env.DATABASE_URL, env.DATABASE_SOCKET_DIR);
  const app = await createApp(env, db, logger);
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const password = `Sample-${randomBytes(9).toString("base64url")}1!`;
  const address = email ?? `sample+${randomBytes(4).toString("hex")}@example.com`;
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${payload.error?.message ?? ""} ${JSON.stringify((payload.error as { fieldErrors?: unknown } | undefined)?.fieldErrors ?? [])}`);
    return payload.data ?? {};
  };
  try {
    const registered = await call("POST", "/api/v1/auth/register", {
      email: address,
      password,
      displayName: "Sample Owner",
      organizationName: "Sample: Mama Put Provisions",
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      industryCode: "general-retail",
      acceptTerms: true,
    });
    token = String(registered.accessToken);
    const tenantId = String((registered.tenant as { tenantId: string }).tenantId);
    await db.execute(sqlTag`UPDATE organizations SET is_sample = true WHERE id = ${tenantId}`);
    const products: string[] = [];
    for (const product of PRODUCTS) products.push(String(((await call("POST", "/api/v1/products", product)).product as { id: string }).id));
    const customers: string[] = [];
    for (const customer of CUSTOMERS) customers.push(String(((await call("POST", "/api/v1/customers", customer)).customer as { id: string }).id));
    await call("PATCH", `/api/v1/customers/${customers[0]}/credit`, { creditAllowed: true, creditLimitMinor: "5000000" }).catch(() => undefined);
    for (let i = 0; i < 8; i += 1) {
      const product = products[i % products.length]!;
      const quantity = String((i % 3) + 1);
      const price = BigInt(PRODUCTS[i % PRODUCTS.length]!.priceMinor) * BigInt(quantity);
      await call("POST", "/api/v1/sales", { lines: [{ productId: product, quantity, unit: PRODUCTS[i % PRODUCTS.length]!.baseUnit }], payments: [{ method: i % 2 === 0 ? "cash" : "transfer", amountMinor: price.toString() }] });
    }
    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await call("POST", "/api/v1/sales", { customerId: customers[0], lines: [{ productId: products[0], quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "3000000" }], dueDate: due, comment: "Sample credit sale" }).catch((error: Error) => console.warn(`Credit sale skipped: ${error.message}`));
    await call("POST", `/api/v1/debtors/${customers[0]}/payments`, { amountMinor: "1000000", method: "cash" }).catch(() => undefined);
    console.log(`Sample business made: ${tenantId}`);
    console.log(`Sign in: ${address}`);
    console.log(`Password (shown once): ${password}`);
  } finally {
    await app.close();
    await client.end({ timeout: 5 });
  }
}

/** Deletes every row of every sample business, children first, then the people who belong to no other business. */
async function removeSamples(sql: postgres.Sql) {
  const samples = (await sql`SELECT id, name FROM organizations WHERE is_sample`).map((row) => ({ id: String(row.id), name: String(row.name) }));
  if (samples.length === 0) {
    console.log("No sample businesses.");
    return;
  }
  const ids = samples.map((sample) => sample.id);
  const tables = (await sql`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND table_name <> 'organizations'`).map((row) => String(row.table_name));
  await sql.begin(async (tx) => {
    // Lets the database delete this transaction's sample rows, and only sample rows (migration 0039).
    await tx`SELECT set_config('bizora.remove_sample', 'on', true)`;
    const people = (await tx`SELECT DISTINCT user_id FROM memberships WHERE tenant_id IN ${tx(ids)} AND user_id NOT IN (SELECT user_id FROM memberships WHERE tenant_id NOT IN ${tx(ids)})`).map((row) => String(row.user_id));
    // Rows refer to each other (a sale to its journal entry, a payment to its sale): delete what nothing points at,
    // round after round, until every table is empty for these businesses.
    // The business points at its own address; let go of it first.
    await tx.unsafe(`UPDATE organizations SET address_id = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    let left = [...tables];
    for (let round = 0; left.length > 0 && round < 20; round += 1) {
      const next: string[] = [];
      for (const table of left) {
        try {
          await tx.savepoint((inner) => inner.unsafe(`DELETE FROM "${table}" WHERE tenant_id = ANY($1::uuid[])`, [ids]));
        } catch {
          next.push(table);
        }
      }
      if (next.length === left.length) throw new Error(`Could not remove rows from: ${next.join(", ")}`);
      left = next;
    }
    if (people.length > 0) {
      const userTables = (await tx`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'user_id' AND table_name NOT IN ${tx(tables)} AND table_name <> 'users'`).map((row) => String(row.table_name));
      for (const table of userTables) await tx.unsafe(`DELETE FROM "${table}" WHERE user_id = ANY($1::uuid[])`, [people]);
    }
    await tx.unsafe(`DELETE FROM organizations WHERE id = ANY($1::uuid[]) AND is_sample`, [ids]);
    if (people.length > 0) await tx.unsafe(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [people]);
  });
  for (const sample of samples) console.log(`Removed sample business ${sample.id} (${sample.name})`);
}


main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
