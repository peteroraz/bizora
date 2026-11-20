import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { adminReasonSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { AdminCan, AdminGuard, CurrentAdmin, requestMeta, type AdminRequest } from "./admin.guard.js";
import type { AdminStaffMember } from "./admin-session.service.js";
import { AdminStaffService } from "./admin-staff.service.js";

@Controller("api/admin/v1/staff")
@UseGuards(AdminGuard)
@AdminCan("staff.manage")
export class AdminStaffController {
  constructor(@Inject(AdminStaffService) private readonly staff: AdminStaffService) {}

  @Get()
  async list(@Req() req: AdminRequest) {
    return success(await this.staff.list(), req.correlationId ?? "admin");
  }

  @Post()
  async add(@Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(await this.staff.add(body, admin, requestMeta(req).ip), req.correlationId ?? "admin");
  }

  @Patch(":id")
  async roles(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(await this.staff.changeRoles(id, body, admin, requestMeta(req).ip), req.correlationId ?? "admin");
  }

  @Post(":id/remove")
  @HttpCode(200)
  async remove(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    const parsed = adminReasonSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "Say why, in a few words.", 400, [{ field: "reason", message: "Say why, in a few words." }]);
    return success(await this.staff.remove(id, parsed.data.reason, admin, requestMeta(req).ip), req.correlationId ?? "admin");
  }
}
