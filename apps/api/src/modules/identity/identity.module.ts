import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { SessionGuard } from "./session.guard.js";

@Module({
  imports: [TenantModule],
  controllers: [IdentityController],
  providers: [IdentityService, SessionGuard],
  exports: [IdentityService, SessionGuard],
})
export class IdentityModule {}
