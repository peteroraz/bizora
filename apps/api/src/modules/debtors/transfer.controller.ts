import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Permission, TRANSFER_KINDS, success, type TransferKind } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { Idempotent } from "../idempotency/idempotency.interceptor.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { TransferService } from "./transfer.service.js";

const kindOf = (value: string): TransferKind => {
  if (!(TRANSFER_KINDS as readonly string[]).includes(value)) throw new ApiError("NOT_FOUND", "Transfer not found.", 404);
  return value as TransferKind;
};

/** Transfers waiting for confirmation (ADR-031): only those who can see the bank check them. */
@Controller("api/v1/transfers")
@UseGuards(TenantGuard, PermissionGuard)
export class TransferController {
  constructor(@Inject(TransferService) private readonly transfers: TransferService) {}

  @Get()
  @RequirePermissions(Permission.BANK_RECONCILE)
  async list(@CurrentTenant() tenant: TenantContext) {
    return success(await this.transfers.list(tenant), tenant.correlationId);
  }

  @Post(":kind/:id/confirm")
  @HttpCode(200)
  @RequirePermissions(Permission.BANK_RECONCILE)
  @Idempotent()
  async confirm(@CurrentTenant() tenant: TenantContext, @Param("kind") kind: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.transfers.confirm(tenant, kindOf(kind), id, body), tenant.correlationId);
  }

  @Post(":kind/:id/not-received")
  @HttpCode(200)
  @RequirePermissions(Permission.BANK_RECONCILE)
  @Idempotent()
  async notReceived(@CurrentTenant() tenant: TenantContext, @Param("kind") kind: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return success(await this.transfers.notReceived(tenant, kindOf(kind), id, body), tenant.correlationId);
  }
}
