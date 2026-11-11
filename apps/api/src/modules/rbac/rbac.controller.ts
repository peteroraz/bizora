import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Permission, success } from "@bizora/contracts";
import type { Request } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "./permission.guard.js";
import { RequirePermissions } from "./permissions.js";
import { InvitationService } from "./invitation.service.js";
import { TenantGuard } from "../tenant/tenant.guard.js";

@Controller("api/v1")
export class RbacController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  @Get("memberships")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.USERS_READ)
  async memberships(@CurrentTenant() tenant: TenantContext) {
    const items = await this.invitations.listPeople(tenant.tenantId);
    return success({ items }, tenant.correlationId);
  }

  @Get("invitations")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.USERS_READ)
  async listInvitations(@CurrentTenant() tenant: TenantContext) {
    const items = await this.invitations.list(tenant.tenantId);
    return success(
      {
        items: items.map((item) => ({
          id: item.id,
          email: item.email,
          role: item.role,
          status: item.status,
          businessId: item.businessId,
          branchId: item.branchId,
          expiresAt: item.expiresAt,
        })),
      },
      tenant.correlationId,
    );
  }

  @Post("invitations")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.USERS_INVITE)
  async invite(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const invitation = await this.invitations.invite(tenant, body);
    return success({ invitation }, tenant.correlationId);
  }

  @Post("invitations/:id/revoke")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.USERS_INVITE)
  async revoke(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const invitation = await this.invitations.revoke(tenant, id);
    return success({ invitation }, tenant.correlationId);
  }

  @Post("invitations/:id/resend")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.USERS_INVITE)
  async resend(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const invitation = await this.invitations.resend(tenant, id);
    return success({ invitation }, tenant.correlationId);
  }

  @Post("invitations/accept")
  @UseGuards(ThrottlerGuard)
  async accept(@Body() body: unknown, @Req() req: Request & { correlationId?: string }) {
    const result = await this.invitations.accept(body, req.correlationId ?? "unknown");
    return success(result, req.correlationId ?? "unknown");
  }
}
