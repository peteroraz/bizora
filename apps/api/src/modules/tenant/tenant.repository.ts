import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { branches, businesses, memberships, organizations } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import type { AppDatabase } from "../../db/database.js";

@Injectable()
export class TenantRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async findOrganization(tenantId: string) {
    const [row] = await this.db.select().from(organizations).where(eq(organizations.id, tenantId)).limit(1);
    return row ?? null;
  }

  listBusinesses(tenantId: string) {
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

  listBranches(tenantId: string, businessId?: string) {
    if (businessId) {
      return this.db
        .select()
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), eq(branches.businessId, businessId)));
    }
    return this.db.select().from(branches).where(eq(branches.tenantId, tenantId));
  }

  async findBranch(tenantId: string, branchId: string) {
    const [row] = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
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
}
