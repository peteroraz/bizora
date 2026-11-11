import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "./session.service.js";

export const AUTH_IDENTITY_KEY = "authIdentity";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { [AUTH_IDENTITY_KEY]?: unknown }>();
    request[AUTH_IDENTITY_KEY] = await this.sessions.requireIdentity(request);
    return true;
  }
}
