import { ApiError } from "./errors.js";

export type MembershipScope = {
  tenantId: string;
  membershipBusinessId: string | null;
  membershipBranchId: string | null;
};

export type ResolvedScope = {
  businessId: string | null;
  branchId: string | null;
};

export function isOrgWideScope(scope: Pick<MembershipScope, "membershipBusinessId" | "membershipBranchId">) {
  return !scope.membershipBusinessId && !scope.membershipBranchId;
}

export function isBranchScope(scope: Pick<MembershipScope, "membershipBranchId">) {
  return Boolean(scope.membershipBranchId);
}

export function isBusinessScope(scope: Pick<MembershipScope, "membershipBusinessId" | "membershipBranchId">) {
  return Boolean(scope.membershipBusinessId) && !scope.membershipBranchId;
}

export function canManageOrganizationSettings(scope: Pick<MembershipScope, "membershipBusinessId" | "membershipBranchId">) {
  return isOrgWideScope(scope);
}

export function canManageBusinessSettings(
  scope: Pick<MembershipScope, "membershipBusinessId" | "membershipBranchId">,
  businessId: string,
) {
  if (isBranchScope(scope)) return false;
  if (isOrgWideScope(scope)) return true;
  return scope.membershipBusinessId === businessId;
}

export function canManageBranchSettings(
  scope: Pick<MembershipScope, "membershipBusinessId" | "membershipBranchId">,
  branch: { id: string; businessId: string },
) {
  if (scope.membershipBranchId) return scope.membershipBranchId === branch.id;
  if (scope.membershipBusinessId) return scope.membershipBusinessId === branch.businessId;
  return true;
}

export function resolveAssignableScope(
  actor: MembershipScope,
  requested: { businessId?: string; branchId?: string },
): ResolvedScope {
  if (isBranchScope(actor)) {
    if (requested.businessId && requested.businessId !== actor.membershipBusinessId) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    if (requested.branchId && requested.branchId !== actor.membershipBranchId) {
      throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
    }
    if (requested.businessId && !requested.branchId) {
      throw new ApiError("FORBIDDEN", "Branch-scoped users cannot invite into the whole business.", 403);
    }
    return { businessId: actor.membershipBusinessId, branchId: actor.membershipBranchId };
  }

  if (isBusinessScope(actor)) {
    if (requested.businessId && requested.businessId !== actor.membershipBusinessId) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    return {
      businessId: actor.membershipBusinessId,
      branchId: requested.branchId ?? null,
    };
  }

  return {
    businessId: requested.businessId ?? null,
    branchId: requested.branchId ?? null,
  };
}
