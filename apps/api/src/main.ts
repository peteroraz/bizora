import "reflect-metadata";
import { loadEnv } from "@bizora/config/env";
import { createPostgresDatabase } from "./db/database.js";
import { createLogger, reportError } from "./logging.js";
import { createApp } from "./bootstrap.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  // Anything that escapes a request still reaches Error Reporting (ADR-036).
  process.on("unhandledRejection", (reason) => reportError(logger, reason, { service: "bizora-api" }));
  process.on("uncaughtException", (error) => {
    reportError(logger, error, { service: "bizora-api" });
    process.exit(1);
  });
  const { db } = createPostgresDatabase(env.DATABASE_URL, env.DATABASE_SOCKET_DIR);
  const app = await createApp(env, db, logger);
  await app.listen(env.API_PORT, "0.0.0.0");
  logger.info({ port: env.API_PORT }, "Bizora API listening");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
