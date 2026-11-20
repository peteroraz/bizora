import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AppEnv } from "@bizora/config/env";
import { adminCan, type AdminAbility } from "@bizora/contracts";
import type { Request } from "express";
import { ApiError } from "../../common/errors.js";
import { APP_ENV } from "../../tokens.js";
import { AdminSessionService, type AdminStaffMember } from "./admin-session.service.js";

const ABILITY_KEY = "bizora:admin-ability";
const ADMIN_KEY = "bizoraAdmin";

export type AdminRequest = Request & { [ADMIN_KEY]?: AdminStaffMember; correlationId?: string };

/** The ability a route needs (ADR-037). Every admin route must name one. */
export const AdminCan = (ability: AdminAbility) => SetMetadata(ABILITY_KEY, ability);

export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AdminRequest>();
  return request[ADMIN_KEY];
});

/**
 * Admin routes take only the portal's own cookie, never a business sign-in, and only from the portal itself: a
 * request sent by another site (even another Bizora address) is refused before anything is read.
 */
export function refuseForeignRequest(request: Request, env: AppEnv) {
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError("ADMIN_FOREIGN_REQUEST", "This request did not come from the Admin portal.", 403);
  }
  const origin = request.headers.origin;
  const expected = env.ADMIN_WEB_ORIGIN?.replace(/\/$/, "");
  if (typeof origin === "string" && origin !== expected) {
    throw new ApiError("ADMIN_FOREIGN_REQUEST", "This request did not come from the Admin portal.", 403);
  }
  if (!["GET", "HEAD"].includes(request.method) && request.headers["x-bizora-admin"] !== "1") {
    throw new ApiError("ADMIN_FOREIGN_REQUEST", "This request did not come from the Admin portal.", 403);
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    this.sessions.requireEnabled();
    refuseForeignRequest(request, this.env);
    const member = await this.sessions.resolve(request);
    if (!member) throw new ApiError("ADMIN_SIGN_IN_REQUIRED", "Sign in to the Admin portal.", 401);
    request[ADMIN_KEY] = member;
    const ability = this.reflector.getAllAndOverride<AdminAbility | undefined>(ABILITY_KEY, [context.getHandler(), context.getClass()]);
    if (ability === undefined) throw new ApiError("ADMIN_NOT_ALLOWED", "You cannot do this.", 403);
    if (!adminCan(member.roles, ability)) throw new ApiError("ADMIN_NOT_ALLOWED", "Your role cannot do this.", 403);
    return true;
  }
}

export function requestMeta(request: Request) {
  return {
    ip: request.ip ?? null,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
  };
}
