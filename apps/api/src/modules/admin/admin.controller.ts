import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { adminReasonSchema, adminSearchSchema, success, uuidSchema } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { SupportActor } from "../../common/support-actor.js";
import { supportAuditFields } from "../../common/support-actor.js";
import { AuditService } from "../audit/audit.service.js";
import { AccountRecoveryService } from "../identity/account-recovery.service.js";
import { SessionService } from "../identity/session.service.js";
import { InvitationService } from "../rbac/invitation.service.js";
import { ShopDeviceService } from "../staff/shop-device.service.js";
import { AdminAuditService } from "./admin-audit.service.js";
import { AdminDirectoryService } from "./admin-directory.service.js";
import { AdminCan, AdminGuard, CurrentAdmin, requestMeta, type AdminRequest } from "./admin.guard.js";
import type { AdminStaffMember } from "./admin-session.service.js";

function parseReason(body: unknown) {
  const parsed = adminReasonSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "Say why, in a few words.", 400, [{ field: "reason", message: parsed.error.issues[0]?.message ?? "Say why." }]);
  }
  return parsed.data.reason;
}

/** Finding businesses and people, and the support actions that need no access to a business's records (ADR-037). */
@Controller("api/admin/v1")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminDirectoryService) private readonly directory: AdminDirectoryService,
    @Inject(AdminAuditService) private readonly adminAudit: AdminAuditService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(ShopDeviceService) private readonly devices: ShopDeviceService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AccountRecoveryService) private readonly recovery: AccountRecoveryService,
  ) {}

  @Get("businesses")
  @AdminCan("businesses.read")
  async businesses(@Query() query: unknown, @Req() req: AdminRequest) {
    const { q } = adminSearchSchema.parse(query ?? {});
    return success(await this.directory.searchBusinesses(q), req.correlationId ?? "admin");
  }

  @Get("businesses/:id")
  @AdminCan("businesses.read")
  async business(@Param("id") id: string, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const business = await this.directory.business(id);
    await this.adminAudit.record({ staffId: admin.staffId, staffEmail: admin.email, action: "business.viewed", targetType: "business", targetId: id, tenantId: id, ip: requestMeta(req).ip });
    const recent = await this.adminAudit.list({ tenantId: id, limit: 20 });
    return success({ ...business, supportHistory: recent.filter((entry) => entry.action !== "business.viewed") }, req.correlationId ?? "admin");
  }

  @Get("people")
  @AdminCan("people.read")
  async people(@Query() query: unknown, @Req() req: AdminRequest) {
    const { q } = adminSearchSchema.parse(query ?? {});
    return success(await this.directory.searchPeople(q), req.correlationId ?? "admin");
  }

  @Get("people/:id")
  @AdminCan("people.read")
  async person(@Param("id") id: string, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const person = await this.directory.person(id);
    await this.adminAudit.record({ staffId: admin.staffId, staffEmail: admin.email, action: "person.viewed", targetType: "person", targetId: id, ip: requestMeta(req).ip });
    return success(person, req.correlationId ?? "admin");
  }

  @Post("invitations/:id/resend")
  @HttpCode(200)
  @AdminCan("support.act")
  async resendInvitation(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const actor = this.actor(admin, parseReason(body), req);
    if (!(await this.directory.invitation(id))) throw new ApiError("INVITATION_NOT_FOUND", "Invitation was not found.", 404);
    const sent = await this.invitations.resendForSupport(id, actor);
    await this.adminAudit.record({ ...this.trail(actor, "invitation.resent"), targetType: "invitation", targetId: id, tenantId: sent.tenantId, metadata: { email: sent.email } });
    return success({ id: sent.id, email: sent.email, expiresAt: sent.expiresAt.toISOString() }, actor.correlationId);
  }

  @Post("devices/:id/stop")
  @HttpCode(200)
  @AdminCan("devices.stop")
  async stopDevice(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const actor = this.actor(admin, parseReason(body), req);
    const stopped = await this.devices.stopForSupport(id, actor);
    if (!stopped.alreadyStopped) {
      await this.adminAudit.record({ ...this.trail(actor, "device.stopped"), targetType: "device", targetId: id, tenantId: stopped.tenantId });
    }
    return success({ id: stopped.id, status: "stopped" }, actor.correlationId);
  }

  @Post("people/:id/resend-verification")
  @HttpCode(200)
  @AdminCan("support.act")
  async resendVerification(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const actor = this.actor(admin, parseReason(body), req);
    const person = await this.directory.person(id);
    if (!person.email) throw new ApiError("NO_EMAIL", "This person signs in with a PIN and has no email.", 409);
    if (person.emailVerified) throw new ApiError("ALREADY_VERIFIED", "This email is already confirmed.", 409);
    await this.recovery.resendVerification(id);
    await this.adminAudit.record({ ...this.trail(actor, "person.verification_resent"), targetType: "person", targetId: id, metadata: { email: person.email } });
    return success({ sent: true }, actor.correlationId);
  }

  @Post("people/:id/sign-out-everywhere")
  @HttpCode(200)
  @AdminCan("support.act")
  async signOutEverywhere(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const actor = this.actor(admin, parseReason(body), req);
    const person = await this.directory.person(id);
    await this.sessions.revokeAllForUser(id);
    // Each business the person works in sees this in its own log.
    for (const place of person.businesses) {
      await this.audit.record({ ...supportAuditFields(actor), tenantId: place.tenantId, action: "user.signed_out_everywhere", entityType: "user", entityId: id });
    }
    await this.adminAudit.record({ ...this.trail(actor, "person.signed_out_everywhere"), targetType: "person", targetId: id, metadata: { businesses: person.businesses.length } });
    return success({ signedOut: true }, actor.correlationId);
  }

  @Get("audit")
  @AdminCan("audit.read")
  async auditLog(@Query("tenantId") tenantId: string | undefined, @Query("before") before: string | undefined, @Req() req: AdminRequest) {
    const beforeDate = before ? new Date(before) : undefined;
    const rows = await this.adminAudit.list({
      ...(tenantId && uuidSchema.safeParse(tenantId).success ? { tenantId } : {}),
      ...(beforeDate && !Number.isNaN(beforeDate.getTime()) ? { before: beforeDate } : {}),
      limit: 50,
    });
    return success(rows, req.correlationId ?? "admin");
  }

  private actor(admin: AdminStaffMember, reason: string, req: AdminRequest): SupportActor {
    const meta = requestMeta(req);
    return { staffId: admin.staffId, staffEmail: admin.email, reason, correlationId: req.correlationId ?? "admin", ip: meta.ip, userAgent: meta.userAgent };
  }

  private trail(actor: SupportActor, action: string) {
    return { staffId: actor.staffId, staffEmail: actor.staffEmail, action, reason: actor.reason, ip: actor.ip ?? null };
  }
}
