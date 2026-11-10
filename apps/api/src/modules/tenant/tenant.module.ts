import { Module } from "@nestjs/common";
import { TenantController } from "./tenant.controller.js";
import { TenantGuard } from "./tenant.guard.js";
import { TenantRepository } from "./tenant.repository.js";

@Module({
  controllers: [TenantController],
  providers: [TenantRepository, TenantGuard],
  exports: [TenantRepository, TenantGuard],
})
export class TenantModule {}
