import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { REFRESH_COOKIE, SESSION_COOKIE } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { ttlToMs } from "@bizora/config/env";
import { refreshRequestSchema, registerRequestSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { CookieOptions, Request, Response } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { APP_ENV } from "../../tokens.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { IdentityService, type AuthPayload } from "./identity.service.js";
import { AUTH_IDENTITY_KEY, SessionGuard } from "./session.guard.js";
import { SessionService } from "./session.service.js";

type AuthedRequest = Request & {
  correlationId?: string;
  [AUTH_IDENTITY_KEY]?: { userId: string; sessionId: string };
};

@Controller("api/v1/auth")
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Post("register")
  @UseGuards(ThrottlerGuard)
  async register(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const parsed = registerRequestSchema.parse(body);
    const session = await this.identity.register(parsed, this.meta(req));
    this.setAuthCookies(res, session);
    return success(session, req.correlationId ?? "unknown");
  }

  @Post("login")
  @UseGuards(ThrottlerGuard)
  async login(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const session = await this.identity.login(body, this.meta(req));
    this.setAuthCookies(res, session);
    return success(session, req.correlationId ?? "unknown");
  }

  @Post("select-context")
  @UseGuards(SessionGuard)
  async selectContext(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const identity = req[AUTH_IDENTITY_KEY];
    if (!identity) {
      throw new Error("Missing identity");
    }
    const session = await this.identity.selectContext(identity.userId, identity.sessionId, body, this.meta(req));
    this.setAuthCookies(res, session);
    return success(session, req.correlationId ?? "unknown");
  }

  @Post("refresh")
  @UseGuards(ThrottlerGuard)
  async refresh(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const parsed = refreshRequestSchema.parse(body ?? {});
    const token = this.sessions.readRefreshToken(req, parsed.refreshToken);
    if (!token) {
      throw new ApiError("UNAUTHENTICATED", "Refresh token is required.", 401);
    }
    const tokens = await this.identity.refresh(token, this.meta(req));
    this.writeCookies(res, tokens.accessToken, tokens.refreshToken);
    return success(tokens, req.correlationId ?? "unknown");
  }

  @Post("password")
  @UseGuards(ThrottlerGuard, SessionGuard)
  async changePassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    const identity = req[AUTH_IDENTITY_KEY];
    if (!identity) {
      throw new Error("Missing identity");
    }
    await this.identity.changePassword(identity.userId, body);
    return success({ ok: true }, req.correlationId ?? "unknown");
  }

  @Get("me")
  @UseGuards(TenantGuard)
  async me(@CurrentTenant() tenant: TenantContext) {
    const profile = await this.identity.me(tenant.userId, tenant.tenantId);
    return success({ ...profile, tenant }, tenant.correlationId);
  }

  @Post("logout")
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const identity = req[AUTH_IDENTITY_KEY];
    if (identity) {
      await this.identity.logout(identity.userId, identity.sessionId);
    }
    this.clearCookies(res);
    return success({ ok: true }, req.correlationId ?? "unknown");
  }

  private meta(req: AuthedRequest) {
    return {
      correlationId: req.correlationId ?? "unknown",
      ip: req.ip ?? null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    };
  }

  private setAuthCookies(res: Response, session: AuthPayload) {
    if (session.accessToken && session.refreshToken) {
      this.writeCookies(res, session.accessToken, session.refreshToken);
    }
  }

  private writeCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie(SESSION_COOKIE, accessToken, this.cookieOptions(ttlToMs(this.env.JWT_ACCESS_TTL)));
    res.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions(ttlToMs(this.env.JWT_REFRESH_TTL)));
  }

  private clearCookies(res: Response) {
    const base = this.cookieOptions(0);
    res.clearCookie(SESSION_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
  }

  private cookieOptions(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: this.env.COOKIE_SAMESITE,
      path: "/",
      maxAge,
    };
  }
}
