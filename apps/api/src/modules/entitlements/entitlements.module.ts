import { Module } from "@nestjs/common";
import { EntitlementService } from "./entitlement.service.js";
import { FeatureService } from "./feature.service.js";

@Module({
  providers: [EntitlementService, FeatureService],
  exports: [EntitlementService, FeatureService],
})
export class EntitlementsModule {}
