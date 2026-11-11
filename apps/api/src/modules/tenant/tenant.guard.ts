import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../../common/errors.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "../../common/tenant-context.js";
import { AUTH_IDENTITY_KEY } from "../identity/session.guard.js";
import { SessionService } from "../identity/session.service.js";
import { TenantRepository } from "./tenant.repository.js";

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { correlationId?: string; [TENANT_CONTEXT_KEY]?: TenantContext; [AUTH_IDENTITY_KEY]?: unknown }
    >();
    const identity = await this.sessions.requireIdentity(request);
    request[AUTH_IDENTITY_KEY] = identity;
    if (identity.claims.typ !== "access" || !identity.claims.org || !identity.claims.mid) {
      throw new ApiError("UNAUTHENTICATED", "Select a workspace to continue.", 401);
    }

    const membership = await this.tenants.findMembershipById(identity.claims.mid);
    if (!membership || membership.userId !== identity.claims.sub || membership.tenantId !== identity.claims.org) {
      throw new ApiError("UNAUTHENTICATED", "Membership is no longer valid.", 401);
    }

    void request.headers["x-tenant-id"];
    void request.headers["x-organization-id"];

    const requestedBusinessId =
      typeof request.headers["x-business-id"] === "string" ? request.headers["x-business-id"] : (identity.claims.bid ?? null);
    const requestedBranchId =
      typeof request.headers["x-branch-id"] === "string" ? request.headers["x-branch-id"] : (identity.claims.br ?? null);

    if (membership.businessId && requestedBusinessId && requestedBusinessId !== membership.businessId) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    if (membership.branchId && requestedBranchId && requestedBranchId !== membership.branchId) {
      throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
    }

    const businessId = membership.businessId ?? requestedBusinessId ?? null;
    const branchId = membership.branchId ?? requestedBranchId ?? null;

    if (businessId) {
      const business = await this.tenants.findBusiness(membership.tenantId, businessId);
      if (!business) {
        throw new ApiError("FORBIDDEN", "Business is outside the authenticated tenant.", 403);
      }
    }

    if (branchId) {
      const branch = await this.tenants.findBranch(membership.tenantId, branchId);
      if (!branch) {
        throw new ApiError("FORBIDDEN", "Branch is outside the authenticated tenant.", 403);
      }
      if (businessId && branch.businessId !== businessId) {
        throw new ApiError("FORBIDDEN", "Branch does not belong to the selected business.", 403);
      }
    }

    const permissions = await this.tenants.permissionsForRole(membership.role);

    request[TENANT_CONTEXT_KEY] = {
      userId: membership.userId,
      tenantId: membership.tenantId,
      businessId,
      branchId,
      membershipBusinessId: membership.businessId,
      membershipBranchId: membership.branchId,
      membershipId: membership.id,
      role: membership.role as TenantContext["role"],
      permissions,
      correlationId: request.correlationId ?? "unknown",
    };
    return true;
  }
}
