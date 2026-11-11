import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import { AppModule } from "./app.module.js";
import { correlationMiddleware } from "./common/correlation.js";
import { ErrorEnvelopeFilter } from "./common/errors.js";
import type { AppDatabase } from "./db/database.js";

export async function createApp(env: AppEnv, db: AppDatabase, logger: Logger) {
  const app = await NestFactory.create(AppModule.register({ env, db, logger }), {
    logger: ["error", "warn"],
  });
  if (env.TRUST_PROXY) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }
  app.use(cookieParser());
  app.use(correlationMiddleware);
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
  });
  return app;
}
