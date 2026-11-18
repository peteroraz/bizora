import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AppEnv } from "@bizora/config/env";
import { PIN_LOCKOUT, Permission, success } from "@bizora/contracts";
import type { Request, Response } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { APP_ENV } from "../../tokens.js";
import { EntitlementService } from "../entitlements/entitlement.service.js";
import { clearDeviceCookie, clearSessionCookies, writeDeviceCookie, writeSessionCookies } from "../identity/session-cookies.js";
import { SessionService } from "../identity/session.service.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { TenantRepository } from "../tenant/tenant.repository.js";
import { ShopDeviceService } from "./shop-device.service.js";
import { StaffService } from "./staff.service.js";

type ShopRequest = Request & { correlationId?: string };

function meta(req: ShopRequest) {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 512) : null,
  };
}

/** Owner/manager endpoints: staff, shop devices and the workspace plan. */
@Controller("api/v1")
@UseGuards(TenantGuard, PermissionGuard)
export class StaffController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(ShopDeviceService) private readonly devices: ShopDeviceService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get("plan")
  @RequirePermissions(Permission.TENANT_READ)
  async plan(@CurrentTenant() tenant: TenantContext) {
    return success(await this.entitlements.summary(tenant.tenantId), tenant.correlationId);
  }

  @Get("staff")
  @RequirePermissions(Permission.STAFF_MANAGE)
  async list(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.staff.list(tenant) }, tenant.correlationId);
  }

  @Post("staff")
  @RequirePermissions(Permission.STAFF_MANAGE)
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: ShopRequest) {
    return success({ staff: await this.staff.create(tenant, body, meta(req)) }, tenant.correlationId);
  }

  @Post("staff/:id/pin")
  @RequirePermissions(Permission.STAFF_MANAGE)
  async resetPin(
    @CurrentTenant() tenant: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: ShopRequest,
  ) {
    return success({ staff: await this.staff.resetPin(tenant, id, body, meta(req)) }, tenant.correlationId);
  }

  @Post("staff/:id/deactivate")
  @RequirePermissions(Permission.STAFF_MANAGE)
  async deactivate(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Req() req: ShopRequest) {
    return success({ staff: await this.staff.deactivate(tenant, id, meta(req)) }, tenant.correlationId);
  }

  @Post("staff/:id/reactivate")
  @RequirePermissions(Permission.STAFF_MANAGE)
  async reactivate(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Req() req: ShopRequest) {
    return success({ staff: await this.staff.reactivate(tenant, id, meta(req)) }, tenant.correlationId);
  }

  @Get("shop-devices")
  @RequirePermissions(Permission.DEVICES_MANAGE)
  async listDevices(@CurrentTenant() tenant: TenantContext) {
    return success({ items: await this.devices.list(tenant) }, tenant.correlationId);
  }

  /** Turn on Shop mode on the device making this request. */
  @Post("shop-devices")
  @RequirePermissions(Permission.DEVICES_MANAGE)
  async enroll(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @Req() req: ShopRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { device, token } = await this.devices.enroll(tenant, body, meta(req));
    writeDeviceCookie(res, this.env, token);
    // The phone now belongs to the counter: the owner's own sign-in must not stay on it, or anyone could open the
    // owner's screens from the shop. Only a browser sign-in (cookie) is ended; an API client keeps its token.
    if (!req.headers.authorization) {
      const identity = await this.sessions.requireIdentity(req);
      await this.sessions.revoke(identity.sessionId, identity.userId);
      clearSessionCookies(res, this.env);
    }
    return success({ device }, tenant.correlationId);
  }

  /** Turn off Shop mode on the device making this request (owner/manager signed in on it). */
  @Post("shop-devices/current/exit")
  @RequirePermissions(Permission.DEVICES_MANAGE)
  async exitCurrent(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: ShopRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const device = await this.devices.exitCurrent(tenant, this.sessions.readDeviceToken(req), meta(req));
    clearDeviceCookie(res, this.env);
    return success({ device }, tenant.correlationId);
  }

  @Post("shop-devices/:id/revoke")
  @RequirePermissions(Permission.DEVICES_MANAGE)
  async revokeDevice(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Req() req: ShopRequest) {
    return success({ device: await this.devices.revoke(tenant, id, meta(req)) }, tenant.correlationId);
  }

  @Post("shop-devices/:id/approve")
  @RequirePermissions(Permission.DEVICES_MANAGE)
  async approveDevice(@CurrentTenant() tenant: TenantContext, @Param("id") id: string, @Req() req: ShopRequest) {
    return success({ device: await this.devices.approve(tenant, id, meta(req)) }, tenant.correlationId);
  }
}

/**
 * Shop-mode endpoints. These are authenticated by the device cookie only (no user session):
 * the staff picker and PIN sign-in. A PIN is never accepted without a valid device cookie.
 */
@Controller("api/v1/shop")
@UseGuards(ThrottlerGuard)
export class ShopController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(ShopDeviceService) private readonly devices: ShopDeviceService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  @Get("device")
  async device(@Req() req: ShopRequest) {
    const device = await this.devices.resolve(this.sessions.readDeviceToken(req));
    const [organization, business, branch, roster] = await Promise.all([
      this.tenants.findOrganization(device.tenantId),
      this.tenants.findBusiness(device.tenantId, device.businessId),
      this.tenants.findBranch(device.tenantId, device.branchId),
      this.staff.roster(device),
    ]);
    return success(
      {
        device: { id: device.id, name: device.name },
        organizationName: organization?.name ?? null,
        businessName: business?.name ?? null,
        branchName: branch?.name ?? null,
        staff: roster,
        autoLockMinutes: PIN_LOCKOUT.autoLockMinutesDefault,
      },
      req.correlationId ?? "unknown",
    );
  }

  @Post("pin-login")
  async pinLogin(@Body() body: unknown, @Req() req: ShopRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.staff.pinLogin(this.sessions.readDeviceToken(req), body, {
      ...meta(req),
      correlationId: req.correlationId ?? "unknown",
    });
    writeSessionCookies(res, this.env, result.accessToken, result.refreshToken);
    return success(
      { staff: result.staff, device: result.device, autoLockMinutes: result.autoLockMinutes },
      req.correlationId ?? "unknown",
    );
  }
}
