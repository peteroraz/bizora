import { Module } from "@nestjs/common";
import { SessionService } from "../identity/session.service.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { OnboardingService } from "./onboarding.service.js";
import { TenantController } from "./tenant.controller.js";
import { TenantGuard } from "./tenant.guard.js";
import { TenantRepository } from "./tenant.repository.js";

@Module({
  controllers: [TenantController],
  providers: [TenantRepository, TenantGuard, OnboardingService, PermissionGuard, SessionService],
  exports: [TenantRepository, TenantGuard, OnboardingService, SessionService],
})
export class TenantModule {}
