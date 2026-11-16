import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module.js";
import { NotificationController } from "./notification.controller.js";
import { NotificationService } from "./notification.service.js";

@Module({
  imports: [TenantModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationsModule {}
