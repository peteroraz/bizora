import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { SyncModule } from "../sync/sync.module.js";
import { TenantModule } from "../tenant/tenant.module.js";
import { PaymentController, PublicStatementController } from "./payment.controller.js";
import { PaymentSyncHandler } from "./payment-sync.handler.js";
import { PaymentService } from "./payment.service.js";

@Module({
  imports: [TenantModule, IdempotencyModule, SyncModule, DocumentsModule, LedgerModule],
  controllers: [PaymentController, PublicStatementController],
  providers: [PaymentService, PaymentSyncHandler, PermissionGuard],
})
export class DebtorsModule {}
