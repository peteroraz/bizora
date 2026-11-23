import { z } from "zod";
import { adminReasonSchema } from "./admin.js";

/**
 * Switches for one business (ADR-045), set by Bizora operations in the Admin portal. Each starts as the product works
 * today, so existing businesses see no change until someone switches one.
 *
 * - offline_voice: saying a sale and reading it on the phone (ADR-040). Experimental in the pilot.
 * - photo_reads: reading photos and voice notes with Bizora AI (ADR-018). Drafts only, never saved by itself.
 * - support_view: Bizora staff may open the read-only support view of this business (ADR-039).
 * - advanced_accounting, payment_gateways: not built. Locked off, so they arrive switched off for every business.
 */
export const BUSINESS_FEATURES = ["offline_voice", "photo_reads", "support_view", "advanced_accounting", "payment_gateways"] as const;
export type BusinessFeature = (typeof BUSINESS_FEATURES)[number];
export type BusinessFeatures = Record<BusinessFeature, boolean>;

export const FEATURE_DEFAULTS: BusinessFeatures = {
  offline_voice: true,
  photo_reads: true,
  support_view: true,
  advanced_accounting: false,
  payment_gateways: false,
};

/** Not part of the pilot: cannot be switched on for anyone. */
export const LOCKED_OFF_FEATURES: readonly BusinessFeature[] = ["advanced_accounting", "payment_gateways"];

export const businessFeatureSchema = z.enum(BUSINESS_FEATURES);

export const setBusinessFeatureSchema = z.object({
  feature: businessFeatureSchema,
  enabled: z.boolean(),
  reason: adminReasonSchema.shape.reason,
});
