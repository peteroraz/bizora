import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AppEnv } from "@bizora/config/env";
import { publicWebOrigin } from "@bizora/config/env";
import { ApiError } from "../../common/errors.js";
import type { Request, Response } from "express";
import { APP_ENV } from "../../tokens.js";
import { readCookieValue } from "@bizora/auth";
import { OAUTH_COOKIE, OAUTH_TRANSACTION_TTL_MS, openOauthTransaction, type OauthIntent } from "./oauth-cookie.js";
import { isOauthProvider, OauthService } from "./oauth.service.js";
import { applySession } from "./session-cookies.js";
import { SessionService } from "./session.service.js";

type TracedRequest = Request & { correlationId?: string };

@Controller("api/v1/auth/oauth")
@UseGuards(ThrottlerGuard)
export class OauthController {
  constructor(
    @Inject(OauthService) private readonly oauth: OauthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get(":provider/start")
  async start(
    @Param("provider") provider: string,
    @Query("returnTo") returnTo: string | undefined,
    @Query("intent") intent: string | undefined,
    @Query("token") token: string | undefined,
    @Req() req: TracedRequest,
    @Res() res: Response,
  ) {
    if (!isOauthProvider(provider)) {
      throw new ApiError("OAUTH_DISABLED", "That sign-in method is not available.", 404);
    }
    const mode = normalizeIntent(intent);
    let userId: string | undefined;
    if (mode === "link") {
      try {
        userId = (await this.sessions.requireIdentity(req)).userId;
      } catch {
        res.redirect("/login?reason=session");
        return;
      }
    }
    const started = await this.oauth.begin({
      provider,
      returnTo,
      intent: mode,
      ...(token ? { inviteToken: token } : {}),
      ...(userId ? { userId } : {}),
    });
    res.cookie(OAUTH_COOKIE, started.sealed, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/api/v1/auth/oauth",
      maxAge: OAUTH_TRANSACTION_TTL_MS,
    });
    res.redirect(started.location);
  }

  @Get(":provider/callback")
  async callback(@Param("provider") provider: string, @Req() req: TracedRequest, @Res() res: Response) {
    if (!isOauthProvider(provider)) {
      throw new ApiError("OAUTH_DISABLED", "That sign-in method is not available.", 404);
    }
    const sealed = readCookieValue(req.headers.cookie, OAUTH_COOKIE);
    const transaction = sealed ? openOauthTransaction(sealed, this.env.JWT_SECRET) : null;
    this.clearOauthCookie(res);
    if (!transaction || transaction.provider !== provider) {
      res.redirect("/login?reason=oauth");
      return;
    }
    const currentUrl = new URL(req.originalUrl, publicWebOrigin(this.env));
    try {
      const finished = await this.oauth.finish(transaction, currentUrl, {
        correlationId: req.correlationId ?? "oauth",
        ip: req.ip ?? null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      });
      applySession(res, this.env, finished.session);
      res.redirect(finished.location);
    } catch (error) {
      if (error instanceof ApiError && error.code === "OAUTH_EMAIL_UNVERIFIED") {
        res.redirect("/login?reason=email");
        return;
      }
      if (error instanceof ApiError && error.code === "OAUTH_LINK_REQUIRED") {
        res.redirect("/login?reason=link");
        return;
      }
      if (error instanceof ApiError && error.code === "INVITE_EMAIL_MISMATCH") {
        res.redirect("/login?reason=invite");
        return;
      }
      res.redirect("/login?reason=oauth");
    }
  }

  private clearOauthCookie(res: Response) {
    res.clearCookie(OAUTH_COOKIE, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/api/v1/auth/oauth",
    });
  }
}

function normalizeIntent(value: string | undefined): OauthIntent {
  if (value === "link" || value === "invite") return value;
  return "login";
}
