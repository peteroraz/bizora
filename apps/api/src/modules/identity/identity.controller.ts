import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { SESSION_COOKIE } from "@bizora/auth";
import { registerRequestSchema, success } from "@bizora/contracts";
import type { Request, Response } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { IdentityService } from "./identity.service.js";

@Controller("api/v1/auth")
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Post("register")
  async register(
    @Body() body: unknown,
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = registerRequestSchema.parse(body);
    const session = await this.identity.register(parsed, req.correlationId ?? "unknown");
    this.setCookie(res, session.accessToken);
    return success(session, req.correlationId ?? "unknown");
  }

  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.identity.login(body, req.correlationId ?? "unknown");
    this.setCookie(res, session.accessToken);
    return success(session, req.correlationId ?? "unknown");
  }

  @Post("select-context")
  @UseGuards(TenantGuard)
  async selectContext(
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.identity.selectContext(tenant.userId, body);
    this.setCookie(res, session.accessToken);
    return success(session, tenant.correlationId);
  }

  @Get("me")
  @UseGuards(TenantGuard)
  async me(@CurrentTenant() tenant: TenantContext) {
    const profile = await this.identity.me(tenant.userId, tenant.tenantId);
    return success({ ...profile, tenant }, tenant.correlationId);
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response, @Req() req: Request & { correlationId?: string }) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
    return success({ ok: true }, req.correlationId ?? "unknown");
  }

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }
}
