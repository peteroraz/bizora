import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, sessions, users, organizations, businesses } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { newId } from "./common/ids.js";

describe("session tenant foreign keys", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantA = "";
  let tenantB = "";
  let businessB = "";
  let userId = "";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    userId = newId();
    tenantA = newId();
    tenantB = newId();
    businessB = newId();
    await db.insert(users).values({
      id: userId,
      email: "fk@test.local",
      passwordHash: "x",
      displayName: "FK",
    });
    await db.insert(organizations).values({ id: tenantA, name: "A", slug: `a-${tenantA.slice(0, 8)}` });
    await db.insert(organizations).values({ id: tenantB, name: "B", slug: `b-${tenantB.slice(0, 8)}` });
    await db.insert(businesses).values({
      id: businessB,
      tenantId: tenantB,
      name: "Biz B",
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("rejects a session whose business belongs to another tenant", async () => {
    await expect(
      db.insert(sessions).values({
        id: newId(),
        userId,
        tenantId: tenantA,
        businessId: businessB,
        refreshTokenHash: `hash-${newId()}`,
        familyId: newId(),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow();
  });
});
