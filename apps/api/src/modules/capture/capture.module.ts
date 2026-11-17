import { Module } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { APP_ENV } from "../../tokens.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CAPTURE_MODEL } from "./capture-model.js";
import { CaptureController } from "./capture.controller.js";
import { CaptureService } from "./capture.service.js";
import { FakeCaptureModel } from "./fake-capture.model.js";
import { VertexCaptureModel } from "./vertex-capture.model.js";

@Module({
  imports: [TenantModule, EntitlementsModule],
  controllers: [CaptureController],
  providers: [
    CaptureService,
    PermissionGuard,
    {
      provide: CAPTURE_MODEL,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        if (env.AI_PROVIDER === "fake") return new FakeCaptureModel();
        if (env.AI_PROVIDER === "vertex" && env.VERTEX_PROJECT) {
          return new VertexCaptureModel({ project: env.VERTEX_PROJECT, location: env.VERTEX_LOCATION ?? "global", model: env.VERTEX_MODEL ?? "gemini-3.8-flash" });
        }
        return null;
      },
    },
  ],
})
export class CaptureModule {}
