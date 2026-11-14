import { Module } from "@nestjs/common";
import { RbacModule } from "../rbac/rbac.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import { AuthTokenService } from "./auth-token.service.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { OauthController } from "./oauth.controller.js";
import { OauthService } from "./oauth.service.js";
import { SessionGuard } from "./session.guard.js";

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [IdentityController, OauthController],
  providers: [IdentityService, SessionGuard, AuthTokenService, AccountRecoveryService, OauthService],
  exports: [IdentityService, SessionGuard],
})
export class IdentityModule {}
