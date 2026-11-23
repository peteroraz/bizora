import { Inject, Injectable } from "@nestjs/common";
import {
  BUSINESS_FEATURES,
  FEATURE_DEFAULTS,
  LOCKED_OFF_FEATURES,
  setBusinessFeatureSchema,
  type BusinessFeature,
  type BusinessFeatures,
} from "@bizora/contracts";
import { eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { supportAuditFields, type SupportActor } from "../../common/support-actor.js";
import type { AppDatabase } from "../../db/database.js";
import { businessFeatures, organizations } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";

const OFF_MESSAGES: Record<BusinessFeature, string> = {
  offline_voice: "Saying a sale is switched off for this business. Type the sale instead.",
  photo_reads: "Reading photos and voice notes is switched off for this business. Type the rows instead.",
  support_view: "The support view is switched off for this business.",
  advanced_accounting: "This is not available yet.",
  payment_gateways: "Card and online payments are not available yet. Record the payment as cash, transfer or POS.",
};

/**
 * Switches for one business (ADR-045). The server checks them wherever it can (photo reads, support view); offline voice
 * runs on the phone, so the app hides it and the server cannot stop a copy already downloaded. Locked-off switches
 * (not built) can never be turned on, here or in the database.
 */
@Injectable()
export class FeatureService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async all(tenantId: string): Promise<BusinessFeatures> {
    const rows = await this.db
      .select({ feature: businessFeatures.feature, enabled: businessFeatures.enabled })
      .from(businessFeatures)
      .where(eq(businessFeatures.tenantId, tenantId));
    const features = { ...FEATURE_DEFAULTS };
    for (const row of rows) {
      if ((BUSINESS_FEATURES as readonly string[]).includes(row.feature)) features[row.feature as BusinessFeature] = row.enabled;
    }
    for (const locked of LOCKED_OFF_FEATURES) features[locked] = false;
    return features;
  }

  async isOn(tenantId: string, feature: BusinessFeature) {
    return (await this.all(tenantId))[feature];
  }

  /** Throws FEATURE_OFF (403) when the switch is off for this business. */
  async assertOn(tenantId: string, feature: BusinessFeature) {
    if (!(await this.isOn(tenantId, feature))) throw new ApiError("FEATURE_OFF", OFF_MESSAGES[feature], 403, [{ field: "feature", message: feature }]);
  }

  /** What the Admin portal shows: each switch, whether it is on, and the last change. */
  async forAdmin(tenantId: string) {
    const features = await this.all(tenantId);
    const rows = await this.db.select().from(businessFeatures).where(eq(businessFeatures.tenantId, tenantId));
    return BUSINESS_FEATURES.map((feature) => {
      const row = rows.find((item) => item.feature === feature);
      return {
        feature,
        enabled: features[feature],
        default: FEATURE_DEFAULTS[feature],
        locked: LOCKED_OFF_FEATURES.includes(feature),
        changedAt: row?.updatedAt.toISOString() ?? null,
        reason: row?.reason ?? null,
      };
    });
  }

  /** Bizora operations switch one feature for one business, with a reason. Recorded in both activity logs by the caller and here. */
  async set(tenantId: string, raw: unknown, actor: SupportActor) {
    const parsed = setBusinessFeatureSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", "Check the switch and say why.", 400, parsed.error.issues.map((issue) => ({ field: String(issue.path[0] ?? "form"), message: issue.message })));
    }
    const { feature, enabled, reason } = parsed.data;
    if (enabled && LOCKED_OFF_FEATURES.includes(feature)) throw new ApiError("FEATURE_LOCKED", "This is not part of the pilot and cannot be switched on.", 409);
    const [organization] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, tenantId)).limit(1);
    if (!organization) throw new ApiError("NOT_FOUND", "Business not found.", 404);
    const before = await this.isOn(tenantId, feature);
    await this.db
      .insert(businessFeatures)
      .values({ tenantId, feature, enabled, reason, changedByStaffId: actor.staffId })
      .onConflictDoUpdate({
        target: [businessFeatures.tenantId, businessFeatures.feature],
        set: { enabled, reason, changedByStaffId: actor.staffId, updatedAt: new Date() },
      });
    await this.audit.record({
      ...supportAuditFields(actor),
      tenantId,
      action: "business.feature_changed",
      entityType: "organization",
      entityId: tenantId,
      metadata: { feature, from: before, to: enabled, staffEmail: actor.staffEmail, reason },
    });
    return { feature, from: before, to: enabled };
  }
}
