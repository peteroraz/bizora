import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { adminReasonSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { SupportActor } from "../../common/support-actor.js";
import { AdminLimitsService } from "./admin-limits.service.js";
import { AdminRecordsService, SUPPORT_PAGES, type SupportPage } from "./admin-records.service.js";
import { AdminCan, AdminGuard, CurrentAdmin, requestMeta, type AdminRequest } from "./admin.guard.js";
import type { AdminStaffMember } from "./admin-session.service.js";

function actorFor(admin: AdminStaffMember, reason: string, req: AdminRequest): SupportActor {
  const meta = requestMeta(req);
  return { staffId: admin.staffId, staffEmail: admin.email, reason, correlationId: req.correlationId ?? "admin", ip: meta.ip, userAgent: meta.userAgent };
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
  ) {}

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

  @Put("limits")
  @AdminCan("limits.manage")
  async setLimits(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(await this.limits.set(id, body, actorFor(admin, reasonOf(body), req)), req.correlationId ?? "admin");
  }
}
