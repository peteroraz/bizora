import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { readBearerToken, SESSION_COOKIE, verifyAccessToken } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import type { Request } from "express";
import { ApiError } from "../../common/errors.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "../../common/tenant-context.js";
import { APP_ENV } from "../../tokens.js";
import { TenantRepository } from "./tenant.repository.js";

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { correlationId?: string; [TENANT_CONTEXT_KEY]?: TenantContext }
    >();
    const cookieHeader = request.headers.cookie ?? "";
    const cookieToken = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const token = readBearerToken(request.headers.authorization) ?? cookieToken;
    if (!token) {
      throw new ApiError("UNAUTHENTICATED", "Authentication is required.", 401);
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, this.env.JWT_SECRET);
    } catch {
      throw new ApiError("UNAUTHENTICATED", "Session is invalid or expired.", 401);
    }

    const membership = await this.tenants.findMembershipById(claims.mid);
    if (!membership || membership.userId !== claims.sub || membership.tenantId !== claims.org) {
      throw new ApiError("UNAUTHENTICATED", "Membership is no longer valid.", 401);
    }

    // Client-supplied tenant IDs are ignored. Tenant comes from the verified membership.
    void request.headers["x-tenant-id"];
    void request.headers["x-organization-id"];

    const requestedBusinessId = typeof request.headers["x-business-id"] === "string"
      ? request.headers["x-business-id"]
      : claims.bid;
    const requestedBranchId = typeof request.headers["x-branch-id"] === "string"
      ? request.headers["x-branch-id"]
      : claims.br;

    let businessId = membership.businessId ?? requestedBusinessId;
    let branchId = membership.branchId ?? requestedBranchId;

    if (businessId) {
      const business = await this.tenants.findBusiness(membership.tenantId, businessId);
      if (!business) {
        throw new ApiError("FORBIDDEN", "Business is outside the authenticated tenant.", 403);
      }
    } else {
      businessId = null;
    }

    if (branchId) {
      const branch = await this.tenants.findBranch(membership.tenantId, branchId);
      if (!branch) {
        throw new ApiError("FORBIDDEN", "Branch is outside the authenticated tenant.", 403);
      }
      if (businessId && branch.businessId !== businessId) {
        throw new ApiError("FORBIDDEN", "Branch does not belong to the selected business.", 403);
      }
    } else {
      branchId = null;
    }

    request[TENANT_CONTEXT_KEY] = {
      userId: membership.userId,
      tenantId: membership.tenantId,
      businessId,
      branchId,
      membershipId: membership.id,
      role: membership.role as TenantContext["role"],
      correlationId: request.correlationId ?? "unknown",
    };
    return true;
  }
}
