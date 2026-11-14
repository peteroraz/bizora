import { DynamicModule, Global, Module } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import { APP_ENV, EMAIL, LOGGER } from "../../tokens.js";
import { ConsoleEmailAdapter } from "./console-email.adapter.js";
import { ResendEmailAdapter } from "./resend-email.adapter.js";

@Global()
@Module({})
export class EmailModule {
  static register(): DynamicModule {
    return {
      module: EmailModule,
      providers: [
        {
          provide: EMAIL,
          inject: [APP_ENV, LOGGER],
          useFactory: (env: AppEnv, logger: Logger) => {
            if (env.EMAIL_PROVIDER === "resend" && env.EMAIL_API_KEY && env.EMAIL_FROM) {
              return new ResendEmailAdapter(env.EMAIL_API_KEY, env.EMAIL_FROM, logger);
            }
            return new ConsoleEmailAdapter(logger);
          },
        },
      ],
      exports: [EMAIL],
    };
  }
}
