import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module.js";
import { PilotEventsController } from "./pilot-events.controller.js";
import { PilotEventsService } from "./pilot-events.service.js";
import { TelemetryController } from "./telemetry.controller.js";

/** Browser errors and content security policy reports (ADR-036); pilot measures (ADR-045). */
@Module({
  imports: [TenantModule],
  controllers: [TelemetryController, PilotEventsController],
  providers: [PilotEventsService],
  exports: [PilotEventsService],
})
export class TelemetryModule {}
