import { socketDirFromEnv } from "@bizora/config/env";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, type DatabaseSchema } from "./schema.js";

export type AppDatabase = PostgresJsDatabase<DatabaseSchema> | ReturnType<typeof drizzle<DatabaseSchema>>;

export function createPostgresDatabase(url: string, socketDir?: string) {
  const host = socketDirFromEnv(socketDir);
  const client = postgres(url, {
    max: 10,
    ...(host ? { host } : {}),
  });
  return { client, db: drizzle(client, { schema }) };
}
