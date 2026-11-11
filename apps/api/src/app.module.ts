import { DynamicModule, Module } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import type { Logger } from "pino";
import { CoreModule } from "./core.module.js";
import type { AppDatabase } from "./db/database.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { RbacModule } from "./modules/rbac/rbac.module.js";
import { TenantModule } from "./modules/tenant/tenant.module.js";

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
      imports: [
        CoreModule.forRoot(options),
        AuditModule,
        HealthModule,
        TenantModule,
        IdentityModule,
        RbacModule,
      ],
    };
  }
}
