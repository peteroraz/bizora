import { Inject, Injectable } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { planLimitsSchema, type PlanFeature, type PlanLimit, type PlanLimits } from "@bizora/contracts";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, invitations, memberships, organizationPlans, plans, shopDevices } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";

export const DEFAULT_PLAN_CODE = "starter";

const LIMIT_MESSAGES: Record<PlanLimit, string> = {
  max_branches: "Your plan allows {limit} shop(s). Upgrade your plan to add another shop.",
  max_staff: "Your plan allows {limit} staff. Upgrade your plan to add more staff.",
  max_devices: "Your plan allows {limit} shop device(s). Upgrade your plan or turn off Shop mode on another device.",
};

export type PlanUsage = Record<PlanLimit, number>;

/**
 * Plan limits and features (Addendum v1.2 §12). Enforced on the server when creating
 * branches, staff (PIN staff and invitations) and shop devices. No billing yet.
 *
 * Staff usage counts every active membership except owners, plus pending, unexpired invitations,
 * so invitations cannot be used to get around the staff limit.
 */
@Injectable()
export class EntitlementService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  defaultPlanCode(): string {
    return this.env.DEFAULT_PLAN_CODE ?? DEFAULT_PLAN_CODE;
  }

  /** Give a new organization the default plan. Call inside the transaction that creates it. */
  async assignDefaultPlan(tenantId: string, store: Pick<AppDatabase, "insert"> = this.db) {
    await store
      .insert(organizationPlans)
      .values({ tenantId, planCode: this.defaultPlanCode() })
      .onConflictDoNothing();
  }

  async plan(tenantId: string): Promise<{ code: string; name: string; limits: PlanLimits }> {
    const [row] = await this.db
      .select({ code: plans.code, name: plans.name, limits: plans.limits, overrides: organizationPlans.limitOverrides })
      .from(organizationPlans)
      .innerJoin(plans, eq(organizationPlans.planCode, plans.code))
      .where(eq(organizationPlans.tenantId, tenantId))
      .limit(1);
    if (row) {
      // Limits set for this business in the Admin portal win over the plan (ADR-039).
      return { code: row.code, name: row.name, limits: planLimitsSchema.parse({ ...(row.limits as object), ...(row.overrides ?? {}) }) };
    }
    const [fallback] = await this.db.select().from(plans).where(eq(plans.code, DEFAULT_PLAN_CODE)).limit(1);
    if (!fallback) {
      throw new ApiError("PLAN_MISSING", "No plan is configured for this workspace.", 500);
    }
    return { code: fallback.code, name: fallback.name, limits: planLimitsSchema.parse(fallback.limits) };
  }

  async usage(tenantId: string): Promise<PlanUsage> {
    const [branchRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(branches)
      // Closed shops do not count towards the plan (ADR-032).
      .where(and(eq(branches.tenantId, tenantId), isNull(branches.closedAt)));
    const [memberRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, "ACTIVE"), ne(memberships.role, "OWNER")));
    const [inviteRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(eq(invitations.tenantId, tenantId), eq(invitations.status, "PENDING"), gt(invitations.expiresAt, new Date())),
      );
    const [deviceRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(shopDevices)
      .where(and(eq(shopDevices.tenantId, tenantId), isNull(shopDevices.revokedAt)));
    return {
      max_branches: branchRow?.total ?? 0,
      max_staff: (memberRow?.total ?? 0) + (inviteRow?.total ?? 0),
      max_devices: deviceRow?.total ?? 0,
    };
  }

  async summary(tenantId: string) {
    const [plan, usage] = await Promise.all([this.plan(tenantId), this.usage(tenantId)]);
    return { plan: { code: plan.code, name: plan.name }, limits: plan.limits, usage };
  }

  /** Throws PLAN_LIMIT (HTTP 402) when adding `adding` more would go over the plan limit. */
  async assertWithinLimit(tenantId: string, limit: PlanLimit, adding = 1) {
    const [plan, usage] = await Promise.all([this.plan(tenantId), this.usage(tenantId)]);
    const allowed = plan.limits[limit];
    if (usage[limit] + adding > allowed) {
      throw new ApiError("PLAN_LIMIT", LIMIT_MESSAGES[limit].replace("{limit}", String(allowed)), 402, [
        { field: limit, message: `${usage[limit]}/${allowed}` },
      ]);
    }
  }

  async hasFeature(tenantId: string, feature: PlanFeature): Promise<boolean> {
    const plan = await this.plan(tenantId);
    return plan.limits.features[feature] === true;
  }
}
