import { Module } from "@nestjs/common";
import { TelemetryController } from "./telemetry.controller.js";

/** Browser errors and content security policy reports (ADR-036). */
@Module({ controllers: [TelemetryController] })
export class TelemetryModule {}
