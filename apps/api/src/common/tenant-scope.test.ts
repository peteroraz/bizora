import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { resolveAssignableScope } from "./tenant-scope.js";

const org = { tenantId: "t1", membershipBusinessId: null, membershipBranchId: null };
const businessA = { tenantId: "t1", membershipBusinessId: "biz-a", membershipBranchId: null };
const branchA = { tenantId: "t1", membershipBusinessId: "biz-a", membershipBranchId: "br-a" };

describe("resolveAssignableScope", () => {
  it("lets an organization owner invite org-wide or into a named business", () => {
    expect(resolveAssignableScope(org, {})).toEqual({ businessId: null, branchId: null });
    expect(resolveAssignableScope(org, { businessId: "biz-a" })).toEqual({ businessId: "biz-a", branchId: null });
    expect(resolveAssignableScope(org, { businessId: "biz-b", branchId: "br-b" })).toEqual({
      businessId: "biz-b",
      branchId: "br-b",
    });
  });

  it("blocks a business-scoped admin from inviting into another business", () => {
    expect(() => resolveAssignableScope(businessA, { businessId: "biz-b" })).toThrow(ApiError);
    expect(resolveAssignableScope(businessA, {})).toEqual({ businessId: "biz-a", branchId: null });
  });

  it("blocks a branch-scoped admin from widening to the business or another branch", () => {
    expect(() => resolveAssignableScope(branchA, { businessId: "biz-a" })).toThrow(ApiError);
    expect(() => resolveAssignableScope(branchA, { branchId: "br-b" })).toThrow(ApiError);
    expect(resolveAssignableScope(branchA, {})).toEqual({ businessId: "biz-a", branchId: "br-a" });
  });
});
