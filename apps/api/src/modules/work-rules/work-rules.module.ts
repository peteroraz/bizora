import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { WorkRulesController } from "./work-rules.controller.js";
import { WorkRulesInterceptor } from "./work-rules.interceptor.js";
import { WorkRulesService } from "./work-rules.service.js";

/** Shop locks, opening hours and permission to work outside them (ADR-034). */
@Module({
  imports: [TenantModule, NotificationsModule],
  controllers: [WorkRulesController],
  providers: [WorkRulesService, PermissionGuard, { provide: APP_INTERCEPTOR, useClass: WorkRulesInterceptor }],
  exports: [WorkRulesService],
})
export class WorkRulesModule {}
