import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createPostgresDatabase } from "./database.js";

const legacySocketQuery = ["?", "host="].join("");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const skipDirectories = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  ".terraform",
]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".tf",
  ".tfvars",
  ".hcl",
  ".yml",
  ".yaml",
  ".md",
  ".json",
  ".sql",
  ".example",
  ".txt",
]);

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await filesContaining(full, needle)));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    const textFile =
      textExtensions.has(extension) || entry.name === "Dockerfile" || entry.name === ".env.example";
    if (!textFile) continue;
    const text = await readFile(full, "utf8");
    if (text.includes(needle)) hits.push(path.relative(repoRoot, full));
  }
  return hits;
}

describe("Cloud SQL socket directory", () => {
  it("opens the connector socket from DATABASE_SOCKET_DIR", async () => {
    const connectionName = "bizora-staging:europe-west1:bizora-pg";
    const socketDir = `/cloudsql/${connectionName}`;
    const password = "s3cret-pass";
    const url = `postgres://bizora_app:${encodeURIComponent(password)}@localhost/bizora`;

    const { client } = createPostgresDatabase(url, socketDir);
    try {
      expect(client.options.path).toBe(`/cloudsql/${connectionName}/.s.PGSQL.5432`);
      expect(client.options.database).toBe("bizora");
      expect(client.options.user).toBe("bizora_app");
      expect(client.options.pass).toBe(password);
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it("leaves a local URL on TCP when DATABASE_SOCKET_DIR is unset", async () => {
    const { client } = createPostgresDatabase("postgres://bizora:bizora@localhost:5432/bizora");
    try {
      expect(client.options.path).toBeFalsy();
      expect(client.options.host).toEqual(["localhost"]);
      expect(client.options.port).toEqual([5432]);
      expect(client.options.database).toBe("bizora");
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it("rejects the empty-host URL postgres.js cannot parse", () => {
    const url = `postgres://u:p@/bizora${legacySocketQuery}/cloudsql/X`;
    expect(() => postgres(url)).toThrow(TypeError);
  });

  it("does not use the legacy socket query form anywhere", async () => {
    await expect(filesContaining(repoRoot, legacySocketQuery)).resolves.toEqual([]);
  });
});
