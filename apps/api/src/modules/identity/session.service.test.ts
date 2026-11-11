import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { AppEnv } from "@bizora/config/env";
import { sha256Hex } from "@bizora/auth";
import { schema, sessions, users, organizations, memberships } from "../../db/schema.js";
import { loadMigrationSql } from "../../db/sql.js";
import { newId } from "../../common/ids.js";
import { SessionService } from "./session.service.js";

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
};

describe("SessionService.refresh", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
  });

  afterAll(async () => {
    await client?.close();
  });

  it("does not leave the old session revoked when the new session insert fails", async () => {
    const userId = newId();
    const tenantId = newId();
    const membershipId = newId();
    await db.insert(users).values({
      id: userId,
      email: `rollback-${userId}@test.local`,
      passwordHash: "x",
      displayName: "Rollback",
    });
    await db.insert(organizations).values({ id: tenantId, name: "T", slug: `t-${tenantId.slice(0, 8)}` });
    await db.insert(memberships).values({
      id: membershipId,
      tenantId,
      userId,
      role: "OWNER",
      status: "ACTIVE",
    });

    const rawRefresh = "refresh-token-rollback-test-xx";
    const sessionId = newId();
    await db.insert(sessions).values({
      id: sessionId,
      userId,
      tenantId,
      membershipId,
      refreshTokenHash: sha256Hex(rawRefresh),
      familyId: newId(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const failInsert = (target: { insert: typeof db.insert }) => {
      const originalInsert = target.insert.bind(target);
      target.insert = ((table: unknown) => {
        if (table === sessions) {
          return {
            values: () => {
              throw new Error("simulated insert failure");
            },
          };
        }
        return originalInsert(table as never);
      }) as typeof db.insert;
    };
    failInsert(db);
    const originalTransaction = db.transaction.bind(db);
    db.transaction = (async (callback: Parameters<typeof db.transaction>[0]) =>
      originalTransaction(async (tx) => {
        failInsert(tx);
        return callback(tx);
      })) as typeof db.transaction;

    const service = new SessionService(db, env);
    await expect(service.refresh(rawRefresh)).rejects.toThrow("simulated insert failure");

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.revokedAt).toBeNull();
  });
});
