import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PermissionCode } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "../../common/tenant-context.js";
import { PERMISSIONS_KEY } from "./permissions.js";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ [TENANT_CONTEXT_KEY]?: TenantContext }>();
    const tenant = request[TENANT_CONTEXT_KEY];
    if (!tenant) {
      throw new ApiError("UNAUTHENTICATED", "Authentication is required.", 401);
    }
    const missing = required.filter((code) => !tenant.permissions.includes(code));
    if (missing.length > 0) {
      throw new ApiError("FORBIDDEN", "You do not have permission to perform this action.", 403);
    }
    return true;
  }
}
