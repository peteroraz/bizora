/** Account, workspace, onboarding and settings contracts (moved out of index.ts so the entry stays re-exports only). */
import { z } from "zod";
import { addressInputSchema, optionalPhoneSchema } from "./address.js";
import { passwordSchema } from "./password.js";
import { businessTypeSchema, staffCountBandSchema, traderModuleSchema } from "./trader.js";



export const roleSchema = z.enum([
  "OWNER",
  "ADMINISTRATOR",
  "MANAGER",
  "SALES",
  "CASHIER",
  "INVENTORY",
  "ACCOUNTANT",
  "EMPLOYEE",
  "AUDITOR",
]);

export type Role = z.infer<typeof roleSchema>;

export const ROLE_RANK: Record<Role, number> = {
  OWNER: 0,
  ADMINISTRATOR: 1,
  MANAGER: 2,
  ACCOUNTANT: 3,
  SALES: 4,
  INVENTORY: 4,
  CASHIER: 5,
  EMPLOYEE: 6,
  AUDITOR: 6,
};

export function isHigherPrivilege(candidate: Role, actor: Role): boolean {
  return ROLE_RANK[candidate] < ROLE_RANK[actor];
}

export const actorTypeSchema = z.enum(["HUMAN", "STAFF_PIN", "AI_AGENT", "SYSTEM", "API", "WORKFLOW"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const uuidSchema = z.string().uuid();
export const nullableUuidSchema = z.string().uuid().nullable();

export const accessTokenClaimsSchema = z
  .object({
    sub: uuidSchema,
    sid: uuidSchema,
    typ: z.enum(["access", "preauth"]),
    org: uuidSchema.optional(),
    mid: uuidSchema.optional(),
    bid: nullableUuidSchema.optional(),
    br: nullableUuidSchema.optional(),
    role: roleSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.typ === "access") {
      if (!value.org) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "organizationId is required", path: ["org"] });
      }
      if (!value.mid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "membershipId is required", path: ["mid"] });
      }
    }
  });

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fieldErrors: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
        }),
      )
      .default([]),
    correlationId: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function success<T>(data: T, correlationId: string) {
  return { data, meta: { correlationId } };
}

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  displayName: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(160),
  countryCode: z.string().length(2).toUpperCase(),
  baseCurrencyCode: z.string().length(3).toUpperCase().optional(),
  timezone: z.string().min(1).optional(),
  industryCode: z.string().min(1).max(64).optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const selectContextRequestSchema = z.object({
  organizationId: z.string().uuid(),
  businessId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(16).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(16),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(16),
});

export const createOrganizationSchema = registerRequestSchema.pick({
  organizationName: true,
  countryCode: true,
  baseCurrencyCode: true,
  timezone: true,
  industryCode: true,
});

export const tenantContextSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  businessId: z.string().uuid().nullable(),
  branchId: z.string().uuid().nullable(),
  membershipId: z.string().uuid(),
  role: roleSchema,
});

export type TenantContextDto = z.infer<typeof tenantContextSchema>;

export const workspaceOptionSchema = z.object({
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  membershipId: z.string().uuid(),
  role: roleSchema,
  businessId: z.string().uuid().nullable(),
  businessName: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  branchName: z.string().nullable(),
});

export type WorkspaceOption = z.infer<typeof workspaceOptionSchema>;

export type AuthWorkspace = Pick<
  WorkspaceOption,
  "organizationId" | "organizationName" | "role" | "businessName" | "branchName"
>;


const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color");

export const completeOnboardingSchema = z.object({
  organizationName: z.string().min(1).max(160).optional(),
  businessName: z.string().min(1).max(160).optional(),
  countryCode: z.string().length(2).toUpperCase(),
  industryCode: z.string().min(1).max(64).optional(),
  businessType: businessTypeSchema.optional(),
  baseCurrencyCode: z.string().length(3).toUpperCase(),
  timezone: z.string().min(1),
  branchName: z.string().min(1).max(160).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  logoUrl: z.union([z.string().url().max(2048), z.literal("")]).optional(),
  address: addressInputSchema.optional(),
  phoneE164: optionalPhoneSchema,
  marketOrPlaza: z.string().trim().max(200).optional(),
  tradeCity: z.string().trim().max(120).optional(),
  tradeSubdivisionCode: z.string().trim().max(16).nullable().optional(),
  otherCurrencies: z.boolean().optional(),
  staffCountBand: staffCountBandSchema.optional(),
  branchCount: z.number().int().min(1).max(500).optional(),
  whatYouSell: z.union([z.string().trim().max(500), z.literal(""), z.null()]).optional(),
}).superRefine((value, ctx) => {
  if (!value.industryCode && !value.businessType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["businessType"],
      message: "Choose a business type.",
    });
  }
  if (value.address && value.address.countryCode !== value.countryCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["address", "countryCode"],
      message: "Address country must match the business country.",
    });
  }
});

export const updateBrandingSchema = z.object({
  logoUrl: z.union([z.string().url().max(2048), z.literal(""), z.null()]).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
});

export const updateBusinessSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  countryCode: z.string().length(2).toUpperCase().optional(),
  baseCurrencyCode: z.string().length(3).toUpperCase().optional(),
  timezone: z.string().min(1).optional(),
  industryCode: z.string().min(1).max(64).nullable().optional(),
  phoneE164: optionalPhoneSchema,
  businessType: businessTypeSchema.optional(),
  otherCurrencies: z.boolean().optional(),
  staffCountBand: staffCountBandSchema.optional(),
  branchCount: z.number().int().min(1).max(500).optional(),
  whatYouSell: z.union([z.string().trim().max(500), z.literal(""), z.null()]).optional(),
  multiCurrencyEnabled: z.boolean().optional(),
  staffFeaturesEnabled: z.boolean().optional(),
  visibleModules: z.array(traderModuleSchema).optional(),
});

export const updateBranchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  phoneE164: optionalPhoneSchema,
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  phoneE164: optionalPhoneSchema,
});

export const createInvitationSchema = z.object({
  email: z.string().email(),
  role: roleSchema,
  businessId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16),
  displayName: z.string().min(1).max(120),
  password: passwordSchema.optional(),
});

export const createBranchSchema = z.object({
  name: z.string().min(1).max(160),
  businessId: z.string().uuid().optional(),
});
