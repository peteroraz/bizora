import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function loadMigrationSql(): Promise<{ id: string; sql: string }[]> {
  const files = (await readdir(drizzleDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      id: file,
      sql: await readFile(path.join(drizzleDir, file), "utf8"),
    })),
  );
}

export async function applySqlBatches(
  exec: (sql: string) => Promise<unknown>,
  sql: string,
): Promise<void> {
  const batches = sql
    .split(/;\s*$/m)
    .map((batch) => batch.trim())
    .filter(Boolean);
  for (const batch of batches) {
    await exec(`${batch};`);
  }
}
