import "reflect-metadata";
import { loadEnv } from "@bizora/config/env";
import { createPostgresDatabase } from "./db/database.js";
import { createLogger } from "./logging.js";
import { createApp } from "./bootstrap.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const { db } = createPostgresDatabase(env.DATABASE_URL, env.DATABASE_SOCKET_DIR);
  const app = await createApp(env, db, logger);
  await app.listen(env.API_PORT, "0.0.0.0");
  logger.info({ port: env.API_PORT }, "Bizora API listening");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
