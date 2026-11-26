import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { adminReasonSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { SupportActor } from "../../common/support-actor.js";
import { FeatureService } from "../entitlements/feature.service.js";
import { AdminAuditService } from "./admin-audit.service.js";
import { AdminLifecycleService } from "./admin-lifecycle.service.js";
import { AdminMeasuresService } from "./admin-measures.service.js";
import { AdminLimitsService } from "./admin-limits.service.js";
import { AdminRecordsService, SUPPORT_PAGES, type SupportPage } from "./admin-records.service.js";
import { AdminCan, AdminGuard, CurrentAdmin, requestMeta, type AdminRequest } from "./admin.guard.js";
import type { AdminStaffMember } from "./admin-session.service.js";

function actorFor(admin: AdminStaffMember, reason: string, req: AdminRequest): SupportActor {
  const meta = requestMeta(req);
  return { staffId: admin.staffId, staffEmail: admin.email, reason, correlationId: req.correlationId ?? "admin", ip: meta.ip, userAgent: meta.userAgent };
}

function actorMeta(admin: AdminStaffMember, req: AdminRequest) {
  const meta = requestMeta(req);
  return { staffId: admin.staffId, staffEmail: admin.email, correlationId: req.correlationId ?? "admin", ip: meta.ip, userAgent: meta.userAgent };
}

function reasonOf(body: unknown) {
  const parsed = adminReasonSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "Say why, in a few words.", 400, [{ field: "reason", message: "Say why, in a few words." }]);
  return parsed.data.reason;
}

/** The support view of a business's records and its limits (ADR-039). */
@Controller("api/admin/v1/businesses/:id")
@UseGuards(AdminGuard)
export class AdminBusinessController {
  constructor(
    @Inject(AdminRecordsService) private readonly records: AdminRecordsService,
    @Inject(AdminLimitsService) private readonly limits: AdminLimitsService,
    @Inject(FeatureService) private readonly features: FeatureService,
    @Inject(AdminAuditService) private readonly adminAudit: AdminAuditService,
    @Inject(AdminMeasuresService) private readonly measures: AdminMeasuresService,
    @Inject(AdminLifecycleService) private readonly lifecycle: AdminLifecycleService,
  ) {}

  /** Whether Bizora has suspended this business, and every change with who, why and when (ADR-071). */
  @Get("lifecycle")
  @AdminCan("businesses.read")
  async lifecycleState(@Param("id", ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return success({ lifecycle: await this.lifecycle.state(id) }, req.correlationId ?? "admin");
  }

  @Post("suspend")
  @HttpCode(200)
  @AdminCan("business.suspend")
  async suspend(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success({ lifecycle: await this.lifecycle.suspend(id, body, admin, actorMeta(admin, req)) }, req.correlationId ?? "admin");
  }

  @Post("reinstate")
  @HttpCode(200)
  @AdminCan("business.reinstate")
  async reinstate(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success({ lifecycle: await this.lifecycle.reinstate(id, body, admin, actorMeta(admin, req)) }, req.correlationId ?? "admin");
  }

  /** For support (ADR-045): sync refusals, voice problems and sign-ins of the last 7 days. Codes and counts only. */
  @Get("health")
  @AdminCan("businesses.read")
  async health(@Param("id", ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return success(await this.measures.health(id), req.correlationId ?? "admin");
  }

  @Get("support-view")
  @AdminCan("records.read")
  async current(@Param("id") id: string, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success({ view: await this.records.current(admin, id) }, req.correlationId ?? "admin");
  }

  @Post("support-view")
  @AdminCan("records.read")
  async open(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success({ view: await this.records.open(admin, id, actorFor(admin, reasonOf(body), req)) }, req.correlationId ?? "admin");
  }

  @Post("support-view/close")
  @HttpCode(200)
  @AdminCan("records.read")
  async close(@Param("id") id: string, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(await this.records.close(admin, id, requestMeta(req).ip), req.correlationId ?? "admin");
  }

  @Get("records/:page")
  @AdminCan("records.read")
  async read(@Param("id") id: string, @Param("page") page: string, @Query() query: Record<string, string | undefined>, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    if (!(SUPPORT_PAGES as readonly string[]).includes(page)) throw new ApiError("NOT_FOUND", "Not found.", 404);
    const meta = requestMeta(req);
    const params = { businessId: query.businessId, branchId: query.branchId, id: query.saleId, date: query.date, q: query.q?.slice(0, 120), page: query.page };
    return success(await this.records.read(admin, id, page as SupportPage, params, { correlationId: req.correlationId ?? "admin", ip: meta.ip, userAgent: meta.userAgent }), req.correlationId ?? "admin");
  }

  @Get("limits")
  @AdminCan("businesses.read")
  async getLimits(@Param("id") id: string, @Req() req: AdminRequest) {
    return success(await this.limits.get(id), req.correlationId ?? "admin");
  }

  /** Switches for this business (ADR-045). */
  @Get("features")
  @AdminCan("businesses.read")
  async getFeatures(@Param("id", ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return success({ features: await this.features.forAdmin(id) }, req.correlationId ?? "admin");
  }

  @Put("features")
  @AdminCan("limits.manage")
  async setFeature(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const actor = actorFor(admin, reasonOf(body), req);
    const change = await this.features.set(id, body, actor);
    await this.adminAudit.record({ staffId: admin.staffId, staffEmail: admin.email, action: "business.feature_changed", targetType: "business", targetId: id, tenantId: id, reason: actor.reason, metadata: change, ip: actor.ip ?? null });
    return success({ features: await this.features.forAdmin(id) }, req.correlationId ?? "admin");
  }

  @Put("limits")
  @AdminCan("limits.manage")
  async setLimits(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(await this.limits.set(id, body, actorFor(admin, reasonOf(body), req)), req.correlationId ?? "admin");
  }
}
