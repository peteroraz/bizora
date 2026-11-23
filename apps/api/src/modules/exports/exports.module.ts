import { Module } from "@nestjs/common";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { BusinessExportService } from "./business-export.service.js";
import { ExportsController } from "./exports.controller.js";

@Module({
  imports: [TenantModule],
  controllers: [ExportsController],
  providers: [BusinessExportService, PermissionGuard],
})
export class ExportsModule {}
