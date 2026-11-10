import { DynamicModule, Module } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import type { AppDatabase } from "./db/database.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { TenantModule } from "./modules/tenant/tenant.module.js";
import { APP_ENV, DB, LOGGER } from "./tokens.js";

export type AppModuleOptions = {
  env: AppEnv;
  db: AppDatabase;
  logger: Logger;
};

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [AuditModule, HealthModule, TenantModule, IdentityModule],
      providers: [
        { provide: APP_ENV, useValue: options.env },
        { provide: DB, useValue: options.db },
        { provide: LOGGER, useValue: options.logger },
      ],
      exports: [APP_ENV, DB, LOGGER],
    };
  }
}
