import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { PermissionCode } from "@bizora/contracts";
import {
  branches,
  businesses,
  countryPacks,
  industryPacks,
  memberships,
  organizations,
  permissions,
  rolePermissions,
} from "../../db/schema.js";
import { DB } from "../../tokens.js";
import type { AppDatabase } from "../../db/database.js";
import type { TenantContext } from "../../common/tenant-context.js";

@Injectable()
export class TenantRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async findOrganization(tenantId: string) {
    const [row] = await this.db.select().from(organizations).where(eq(organizations.id, tenantId)).limit(1);
    return row ?? null;
  }

  listBusinesses(tenantId: string, membershipBusinessId?: string | null) {
    if (membershipBusinessId) {
      return this.db
        .select()
        .from(businesses)
        .where(and(eq(businesses.tenantId, tenantId), eq(businesses.id, membershipBusinessId)));
    }
    return this.db.select().from(businesses).where(eq(businesses.tenantId, tenantId));
  }

  async findBusiness(tenantId: string, businessId: string) {
    const [row] = await this.db
      .select()
      .from(businesses)
      .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }

  listBranches(tenant: Pick<TenantContext, "tenantId" | "businessId" | "membershipBranchId" | "membershipBusinessId">) {
    if (tenant.membershipBranchId) {
      return this.db
        .select()
        .from(branches)
        .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, tenant.membershipBranchId)));
    }
    const businessId = tenant.membershipBusinessId ?? tenant.businessId;
    if (businessId) {
      return this.db
        .select()
        .from(branches)
        .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, businessId)));
    }
    return this.db.select().from(branches).where(eq(branches.tenantId, tenant.tenantId));
  }

  async findBranch(tenantId: string, branchId: string) {
    const [row] = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }

  async findVisibleBranch(tenant: TenantContext, branchId: string) {
    if (tenant.membershipBranchId && tenant.membershipBranchId !== branchId) {
      return null;
    }
    const branch = await this.findBranch(tenant.tenantId, branchId);
    if (!branch) return null;
    const lockedBusiness = tenant.membershipBusinessId ?? tenant.businessId;
    if (lockedBusiness && branch.businessId !== lockedBusiness) {
      return null;
    }
    return branch;
  }

  async findMembershipById(membershipId: string) {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.status, "ACTIVE")))
      .limit(1);
    return row ?? null;
  }

  async findMembership(tenantId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          eq(memberships.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  listMemberships(tenantId: string) {
    return this.db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
  }

  async permissionsForRole(role: string): Promise<PermissionCode[]> {
    const rows = await this.db
      .select({ code: permissions.code })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.role, role));
    return rows.map((row) => row.code as PermissionCode);
  }

  listCountryPacks() {
    return this.db.select().from(countryPacks);
  }

  listIndustryPacks() {
    return this.db.select().from(industryPacks);
  }

  async findCountryPack(code: string) {
    const [row] = await this.db.select().from(countryPacks).where(eq(countryPacks.code, code)).limit(1);
    return row ?? null;
  }

  async findIndustryPack(code: string) {
    const [row] = await this.db.select().from(industryPacks).where(eq(industryPacks.code, code)).limit(1);
    return row ?? null;
  }
}
