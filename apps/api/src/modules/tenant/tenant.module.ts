import { Module } from "@nestjs/common";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { OnboardingService } from "./onboarding.service.js";
import { TenantController } from "./tenant.controller.js";
import { TenantGuard } from "./tenant.guard.js";
import { TenantRepository } from "./tenant.repository.js";

@Module({
  controllers: [TenantController],
  providers: [TenantRepository, TenantGuard, OnboardingService, PermissionGuard],
  exports: [TenantRepository, TenantGuard, OnboardingService],
})
export class TenantModule {}
