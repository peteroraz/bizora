import { BrandingModule } from "../branding/branding.module.js";
import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { PaymentController, PublicStatementController } from "./payment.controller.js";
import { PaymentSyncHandler } from "./payment-sync.handler.js";
import { PaymentService } from "./payment.service.js";
import { TransferController } from "./transfer.controller.js";
import { TransferService } from "./transfer.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule, BrandingModule, NotificationsModule],
  controllers: [PaymentController, PublicStatementController, TransferController],
  providers: [PaymentService, TransferService, PaymentSyncHandler, PermissionGuard],
  exports: [PaymentService, TransferService],
})
export class DebtorsModule {}
