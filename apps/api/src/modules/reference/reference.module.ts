import { Module } from "@nestjs/common";
import { SessionGuard } from "../identity/session.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { ReferenceController } from "./reference.controller.js";
import { ReferenceService } from "./reference.service.js";

@Module({
  imports: [TenantModule],
  controllers: [ReferenceController],
  providers: [ReferenceService, SessionGuard],
})
export class ReferenceModule {}
