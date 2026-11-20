import { Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { readCookieValue } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { adminAbilities, success } from "@bizora/contracts";
import type { Response } from "express";
import { APP_ENV } from "../../tokens.js";
import { OAUTH_TRANSACTION_TTL_MS, openOauthTransaction, sealOauthTransaction } from "../identity/oauth-cookie.js";
import { OauthService } from "../identity/oauth.service.js";
import { AdminCan, AdminGuard, CurrentAdmin, requestMeta, type AdminRequest } from "./admin.guard.js";
import { adminCookieOptions, AdminSessionService, type AdminStaffMember } from "./admin-session.service.js";

const ADMIN_OAUTH_COOKIE = "bizora_admin_oauth";
const CALLBACK_PATH = "/api/admin/v1/auth/google/callback";

/** Admin sign-in transactions are sealed with their own key, so a business sign-in can never finish one. */
function adminSealKey(env: AppEnv) {
  return `${env.JWT_SECRET}:admin-portal`;
}

@Controller("api/admin/v1/auth")
export class AdminAuthController {
  constructor(
    @Inject(OauthService) private readonly oauth: OauthService,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get("google/start")
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async start(@Res() res: Response) {
    const origin = this.sessions.requireEnabled();
    const started = await this.oauth.authorize("google", `${origin}${CALLBACK_PATH}`, { prompt: "select_account" });
    const sealed = sealOauthTransaction(
      { provider: "google", state: started.state, nonce: started.nonce, codeVerifier: started.codeVerifier, returnTo: "/", intent: "login" },
      adminSealKey(this.env),
    );
    res.cookie(ADMIN_OAUTH_COOKIE, sealed, { ...adminCookieOptions(this.env, OAUTH_TRANSACTION_TTL_MS), path: CALLBACK_PATH });
    res.redirect(started.location);
  }

  @Get("google/callback")
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async callback(@Req() req: AdminRequest, @Res() res: Response) {
    const origin = this.sessions.requireEnabled();
    const sealed = readCookieValue(req.headers.cookie, ADMIN_OAUTH_COOKIE);
    const transaction = sealed ? openOauthTransaction(decodeURIComponent(sealed), adminSealKey(this.env)) : null;
    const { maxAge: _maxAge, ...clear } = adminCookieOptions(this.env, 0);
    res.clearCookie(ADMIN_OAUTH_COOKIE, { ...clear, path: CALLBACK_PATH });
    if (!transaction) {
      res.redirect("/?error=expired");
      return;
    }
    let profile;
    try {
      profile = await this.oauth.profile(transaction, new URL(req.originalUrl, origin));
    } catch {
      res.redirect("/?error=google");
      return;
    }
    const result = await this.sessions.signIn(profile, requestMeta(req));
    if ("refused" in result) {
      res.redirect(`/?error=${result.refused}`);
      return;
    }
    this.sessions.writeCookie(res, result.token);
    res.redirect("/");
  }

  @Get("me")
  @UseGuards(AdminGuard)
  @AdminCan("businesses.read")
  me(@CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest) {
    return success(
      { email: admin.email, name: admin.name, roles: admin.roles, abilities: adminAbilities(admin.roles) },
      req.correlationId ?? "admin",
    );
  }

  @Post("sign-out")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @AdminCan("businesses.read")
  async signOut(@CurrentAdmin() admin: AdminStaffMember, @Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    await this.sessions.signOut(admin, requestMeta(req).ip);
    this.sessions.clearCookie(res);
    return success({ signedOut: true }, req.correlationId ?? "admin");
  }
}
