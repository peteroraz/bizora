import postgres from "postgres";
import { applySqlBatches, loadMigrationSql } from "./sql.js";

async function migrate() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = postgres(url, { max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const applied = new Set(
      (await sql<{ id: string }[]>`SELECT id FROM schema_migrations`).map((row) => row.id),
    );
    for (const migration of await loadMigrationSql()) {
      if (applied.has(migration.id)) continue;
      await sql.begin(async (tx) => {
        await applySqlBatches((statement) => tx.unsafe(statement), migration.sql);
        await tx`INSERT INTO schema_migrations (id) VALUES (${migration.id}) ON CONFLICT DO NOTHING`;
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

migrate().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
