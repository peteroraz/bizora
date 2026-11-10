import { loadEnv } from "@bizora/config/env";
import { hashPassword } from "@bizora/auth";
import { eq } from "drizzle-orm";
import { createPostgresDatabase } from "./database.js";
import { branches, businesses, countryPacks, industryPacks, memberships, organizations, permissions, rolePermissions, users } from "./schema.js";
import { newId, slugify } from "../common/ids.js";

const SEED_PASSWORD = "LocalOnly!Passw0rd";

async function seedTenant(
  db: ReturnType<typeof createPostgresDatabase>["db"],
  input: { email: string; displayName: string; orgName: string; country: string; currency: string; timezone: string },
) {
  const [existing] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (existing) return existing.id;

  const userId = newId();
  const tenantId = newId();
  const businessId = newId();
  const branchId = newId();
  await db.insert(users).values({
    id: userId,
    email: input.email,
    passwordHash: await hashPassword(SEED_PASSWORD),
    displayName: input.displayName,
  });
  await db.insert(organizations).values({
    id: tenantId,
    name: input.orgName,
    slug: `${slugify(input.orgName)}-${tenantId.slice(0, 8)}`,
  });
  await db.insert(businesses).values({
    id: businessId,
    tenantId,
    name: input.orgName,
    countryCode: input.country,
    baseCurrencyCode: input.currency,
    timezone: input.timezone,
    industryCode: "general-retail",
  });
  await db.insert(branches).values({
    id: branchId,
    tenantId,
    businessId,
    name: "Main",
  });
  await db.insert(memberships).values({
    id: newId(),
    tenantId,
    userId,
    role: "OWNER",
    businessId,
    branchId,
    status: "ACTIVE",
  });
  return userId;
}

async function main() {
  const env = loadEnv();
  const { db, client } = createPostgresDatabase(env.DATABASE_URL);

  await db.insert(countryPacks).values([
    { code: "NG", name: "Nigeria", defaultCurrencyCode: "NGN", defaultTimezone: "Africa/Lagos" },
    { code: "GB", name: "United Kingdom", defaultCurrencyCode: "GBP", defaultTimezone: "Europe/London" },
    { code: "US", name: "United States", defaultCurrencyCode: "USD", defaultTimezone: "America/New_York" },
  ]).onConflictDoNothing();

  await db.insert(industryPacks).values([
    { code: "general-retail", name: "General Retail" },
    { code: "professional-services", name: "Professional Services" },
  ]).onConflictDoNothing();

  const tenantRead = newId();
  await db.insert(permissions).values([
    { id: tenantRead, code: "tenant.read", description: "Read tenant configuration" },
    { id: newId(), code: "tenant.manage", description: "Manage tenant configuration" },
  ]).onConflictDoNothing();
  await db.insert(rolePermissions).values([{ role: "OWNER", permissionId: tenantRead }]).onConflictDoNothing();

  await seedTenant(db, {
    email: "alice@tenant-a.test",
    displayName: "Alice Owner",
    orgName: "Tenant A Foods",
    country: "NG",
    currency: "NGN",
    timezone: "Africa/Lagos",
  });
  await seedTenant(db, {
    email: "bob@tenant-b.test",
    displayName: "Bob Owner",
    orgName: "Tenant B Studio",
    country: "GB",
    currency: "GBP",
    timezone: "Europe/London",
  });

  await client.end({ timeout: 5 });
  console.log("Seed complete. Local passwords are in docs, not in production.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
