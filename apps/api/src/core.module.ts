import { DynamicModule, Global, Module } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import type { AppDatabase } from "./db/database.js";
import { EmptyFinancialLedger } from "./modules/tenant/financial-ledger.port.js";
import { APP_ENV, DB, FINANCIAL_LEDGER, LOGGER } from "./tokens.js";

@Global()
@Module({})
export class CoreModule {
  static forRoot(options: { env: AppEnv; db: AppDatabase; logger: Logger }): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_ENV, useValue: options.env },
        { provide: DB, useValue: options.db },
        { provide: LOGGER, useValue: options.logger },
        { provide: FINANCIAL_LEDGER, useClass: EmptyFinancialLedger },
      ],
      exports: [APP_ENV, DB, LOGGER, FINANCIAL_LEDGER],
    };
  }
}
