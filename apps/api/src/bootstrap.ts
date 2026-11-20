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
export const PRODUCT_PHOTO_PATH = /^\/api\/v1\/products\/[^/]+\/photos$/;
export const CSP_REPORT_PATH = "/api/v1/telemetry/csp";

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
  // Product photos (ADR-033) are shrunk on the phone; at most 600 KB each.
  app.use(PRODUCT_PHOTO_PATH, json({ limit: LOGO_BODY_LIMIT }));
  // Browsers send content security policy reports with their own content types (ADR-036).
  app.use(CSP_REPORT_PATH, json({ limit: "16kb", type: ["application/csp-report", "application/reports+json", "application/json"] }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: DEFAULT_BODY_LIMIT }));
  app.use(cookieParser());
  // API answers are never framed or type-guessed by browsers (review, 19 Nov).
  app.use((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // The API sends data, PDFs and pictures, never pages that run scripts (ADR-036).
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    next();
  });
  app.use(correlationMiddleware);
  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));
  // Admin routes are never shared with other sites (ADR-037); everything else is shared with the business app only.
  app.enableCors((request: { url?: string }, callback: (error: Error | null, options: { origin: string | false; credentials: boolean }) => void) => {
    const admin = (request.url ?? "").startsWith("/api/admin/");
    callback(null, { origin: admin ? false : env.WEB_ORIGIN, credentials: !admin });
  });
  return app;
}
