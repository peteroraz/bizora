import { Inject, Injectable } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { ADMIN_LIMITS, adminLimitsSchema, planLimitsSchema, uuidSchema, type AdminLimit } from "@bizora/contracts";
import { eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { supportAuditFields, type SupportActor } from "../../common/support-actor.js";
import type { AppDatabase } from "../../db/database.js";
import { organizationPlans, plans } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { EntitlementService } from "../entitlements/entitlement.service.js";
import { AdminAuditService } from "./admin-audit.service.js";

/**
 * Limits for one business (ADR-039): shops, staff, shop phones and photo or voice reads a shop a day. The plan gives
 * the starting numbers; a number set here replaces the plan's for that business only. Clearing it goes back to the plan.
 */
@Injectable()
export class AdminLimitsService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(AdminAuditService) private readonly adminAudit: AdminAuditService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(tenantId: string) {
    const row = await this.row(tenantId);
    const base = planLimitsSchema.parse(row.limits);
    const usage = await this.entitlements.usage(tenantId);
    const serverReads = this.env.AI_DAILY_CAPTURE_LIMIT ?? 100;
    return {
      plan: { code: row.code, name: row.name },
      // Reads are also capped for the whole service, whatever is set here.
      serverDailyReads: serverReads,
      limits: ADMIN_LIMITS.map((limit) => ({
        limit,
        plan: limit === "ai_daily_reads" ? (base.ai_daily_reads ?? serverReads) : base[limit],
        set: row.overrides[limit] ?? null,
        used: limit === "ai_daily_reads" ? null : usage[limit],
      })),
    };
  }

  async set(tenantId: string, raw: unknown, actor: SupportActor) {
    const parsed = adminLimitsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", "Check the limits.", 400, parsed.error.issues.map((issue) => ({ field: String(issue.path[0] ?? "form"), message: issue.message })));
    }
    const row = await this.row(tenantId);
    const next: Partial<Record<AdminLimit, number>> = {};
    for (const limit of ADMIN_LIMITS) {
      const value = parsed.data[limit];
      if (value !== null) next[limit] = value;
    }
    await this.db.update(organizationPlans).set({ limitOverrides: next }).where(eq(organizationPlans.tenantId, tenantId));
    const change = { from: row.overrides, to: next };
    await this.adminAudit.record({ staffId: actor.staffId, staffEmail: actor.staffEmail, action: "business.limits_changed", targetType: "business", targetId: tenantId, tenantId, reason: actor.reason, metadata: change, ip: actor.ip ?? null });
    await this.audit.record({ ...supportAuditFields(actor), tenantId, action: "plan.limits_changed", entityType: "organization", entityId: tenantId, metadata: { staffEmail: actor.staffEmail, reason: actor.reason, ...change } });
    return this.get(tenantId);
  }

  private async row(tenantId: string) {
    if (!uuidSchema.safeParse(tenantId).success) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const [row] = await this.db
      .select({ code: plans.code, name: plans.name, limits: plans.limits, overrides: organizationPlans.limitOverrides })
      .from(organizationPlans)
      .innerJoin(plans, eq(plans.code, organizationPlans.planCode))
      .where(eq(organizationPlans.tenantId, tenantId))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    return { ...row, overrides: row.overrides ?? {} };
  }
}
