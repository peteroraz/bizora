import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import { AppModule } from "./app.module.js";
import { correlationMiddleware } from "./common/correlation.js";
import { ErrorEnvelopeFilter } from "./common/errors.js";
import type { AppDatabase } from "./db/database.js";

export const DEFAULT_BODY_LIMIT = "100kb";
export const CUSTOMER_IMPORT_PATH = "/api/v1/customers/import";
export const IMPORTS_PATH = "/api/v1/imports";
export const CUSTOMER_IMPORT_BODY_LIMIT = "1.5mb";
export const CAPTURES_PATH = "/api/v1/captures";
// Photos are shrunk on the phone; this allows a few pages or a 3-minute voice note in base64 (ADR-018).
export const CAPTURE_BODY_LIMIT = "24mb";
// A logo is at most 512 KB, sent as base64 (ADR-021).
export const LOGO_PATH = "/api/v1/organizations/current/logo";
export const LOGO_BODY_LIMIT = "800kb";

export async function createApp(env: AppEnv, db: AppDatabase, logger: Logger) {
  const app = await NestFactory.create(AppModule.register({ env, db, logger }), {
    logger: ["error", "warn"],
    // Body parsing is configured below so that only the CSV import route accepts large bodies.
    bodyParser: false,
  });
  if (env.TRUST_PROXY) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }
  app.use(CUSTOMER_IMPORT_PATH, json({ limit: CUSTOMER_IMPORT_BODY_LIMIT }));
  // Product and sales imports (up to 2,000 rows) get the same larger limit; every other route keeps the small one.
  app.use(IMPORTS_PATH, json({ limit: CUSTOMER_IMPORT_BODY_LIMIT }));
  app.use(CAPTURES_PATH, json({ limit: CAPTURE_BODY_LIMIT }));
  app.use(LOGO_PATH, json({ limit: LOGO_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: DEFAULT_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(correlationMiddleware);
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
  });
  return app;
}
