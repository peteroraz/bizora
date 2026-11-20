import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards, HttpCode } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AppEnv } from "@bizora/config/env";
import { refreshRequestSchema, registerRequestSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import type { Request, Response } from "express";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { APP_ENV } from "../../tokens.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import { IdentityService } from "./identity.service.js";
import { OauthService } from "./oauth.service.js";
import { AUTH_IDENTITY_KEY, SessionGuard } from "./session.guard.js";
import { applySession, clearSessionCookies, writeSessionCookies } from "./session-cookies.js";
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
    @Inject(AccountRecoveryService) private readonly recovery: AccountRecoveryService,
    @Inject(OauthService) private readonly oauth: OauthService,
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

  @Get("workspaces")
  @UseGuards(SessionGuard)
  async workspaces(@Req() req: AuthedRequest) {
    const identity = this.actor(req);
    return success(await this.identity.listAuthWorkspaces(identity.userId), req.correlationId ?? "auth");
  }

  // Not rate-limited by address: renewals from the web server all share its address, and a refresh token is a
  // 256-bit secret that cannot be guessed (ADR-026).
  @Post("refresh")
  async refresh(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const parsed = refreshRequestSchema.parse(body ?? {});
    const token = this.sessions.readRefreshToken(req, parsed.refreshToken);
    if (!token) {
      throw new ApiError("UNAUTHENTICATED", "Refresh token is required.", 401);
    }
    const tokens = await this.identity.refresh(token, { ...this.meta(req), deviceToken: this.sessions.readDeviceToken(req) });
    this.writeCookies(res, tokens.accessToken, tokens.refreshToken);
    return success(tokens, req.correlationId ?? "unknown");
  }

  @Get("providers")
  providers(@Req() req: AuthedRequest) {
    return success(this.oauth.enabled(), req.correlationId ?? "auth");
  }

  @Post("password/forgot")
  @UseGuards(ThrottlerGuard)
  async forgotPassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    return success(await this.recovery.requestPasswordReset(body), req.correlationId ?? "auth");
  }

  @Post("password/reset")
  @UseGuards(ThrottlerGuard)
  async resetPassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    return success(await this.recovery.resetPassword(body, this.meta(req)), req.correlationId ?? "auth");
  }

  @Post("email/verify")
  @UseGuards(ThrottlerGuard)
  async verifyEmail(@Body() body: unknown, @Req() req: AuthedRequest) {
    return success(await this.recovery.confirmVerification(body, this.meta(req)), req.correlationId ?? "auth");
  }

  @Post("email/verification")
  @UseGuards(ThrottlerGuard, SessionGuard)
  async resendVerification(@Req() req: AuthedRequest) {
    const identity = this.actor(req);
    return success(await this.recovery.resendVerification(identity.userId), req.correlationId ?? "auth");
  }

  @Post("organization")
  @UseGuards(SessionGuard)
  async createOrganization(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const identity = this.actor(req);
    const session = await this.identity.createOrganization(identity.userId, body, this.meta(req));
    applySession(res, this.env, session);
    return success(session, req.correlationId ?? "unknown");
  }

  @Get("security")
  @UseGuards(SessionGuard)
  async security(@Req() req: AuthedRequest) {
    const identity = this.actor(req);
    return success(await this.identity.security(identity.userId, identity.sessionId), req.correlationId ?? "auth");
  }

  @Post("identities/:provider/unlink")
  @UseGuards(ThrottlerGuard, SessionGuard)
  async unlink(@Param("provider") provider: string, @Req() req: AuthedRequest) {
    const identity = this.actor(req);
    await this.identity.unlinkIdentity(identity.userId, provider, this.meta(req));
    return success({ ok: true }, req.correlationId ?? "auth");
  }

  @Post("sessions/revoke-others")
  @UseGuards(SessionGuard)
  async revokeOthers(@Req() req: AuthedRequest) {
    const identity = this.actor(req);
    return success(await this.identity.revokeOtherSessions(identity.userId, identity.sessionId), req.correlationId ?? "auth");
  }

  @Post("password")
  @UseGuards(ThrottlerGuard, SessionGuard)
  async changePassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    const identity = this.actor(req);
    await this.identity.changePassword(identity.userId, body);
    return success({ ok: true }, req.correlationId ?? "unknown");
  }

  @Get("me")
  @UseGuards(TenantGuard)
  async me(@CurrentTenant() tenant: TenantContext) {
    const profile = await this.identity.me(tenant.userId, tenant.tenantId);
    return success({ ...profile, tenant }, tenant.correlationId);
  }

  /** An owner accepts the current Terms of use (ADR-039). */
  @Post("accept-terms")
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async acceptTerms(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: AuthedRequest) {
    return success(await this.identity.acceptTerms(tenant.userId, tenant.tenantId, body, this.meta(req)), tenant.correlationId);
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

  private actor(req: AuthedRequest) {
    const identity = req[AUTH_IDENTITY_KEY];
    if (!identity) throw new Error("Missing identity");
    return identity;
  }

  private setAuthCookies(res: Response, session: Parameters<typeof applySession>[2]) {
    applySession(res, this.env, session);
  }

  private writeCookies(res: Response, accessToken: string, refreshToken: string) {
    writeSessionCookies(res, this.env, accessToken, refreshToken);
  }

  private clearCookies(res: Response) {
    clearSessionCookies(res, this.env);
  }
}
