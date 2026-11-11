import { z } from "zod";

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
  password: z.string().min(12).max(128),
  displayName: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(160),
  countryCode: z.string().length(2).toUpperCase(),
  baseCurrencyCode: z.string().length(3).toUpperCase(),
  timezone: z.string().min(1),
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

export const tenantContextSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  businessId: z.string().uuid().nullable(),
  branchId: z.string().uuid().nullable(),
  membershipId: z.string().uuid(),
  role: roleSchema,
});

export type TenantContextDto = z.infer<typeof tenantContextSchema>;

export const Permission = {
  TENANT_READ: "tenant.read",
  TENANT_MANAGE: "tenant.manage",
  BRANDING_MANAGE: "branding.manage",
  USERS_READ: "users.read",
  USERS_INVITE: "users.invite",
  USERS_MANAGE: "users.manage",
  ONBOARDING_COMPLETE: "onboarding.complete",
  BRANCHES_READ: "branches.read",
  BRANCHES_MANAGE: "branches.manage",
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color");

export const completeOnboardingSchema = z.object({
  organizationName: z.string().min(1).max(160).optional(),
  businessName: z.string().min(1).max(160).optional(),
  countryCode: z.string().length(2).toUpperCase(),
  industryCode: z.string().min(1).max(64),
  baseCurrencyCode: z.string().length(3).toUpperCase(),
  timezone: z.string().min(1),
  branchName: z.string().min(1).max(160).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  logoUrl: z.union([z.string().url().max(2048), z.literal("")]).optional(),
});

export const updateBrandingSchema = z.object({
  logoUrl: z.union([z.string().url().max(2048), z.literal(""), z.null()]).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
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
  password: z.string().min(12).max(128).optional(),
});

export const createBranchSchema = z.object({
  name: z.string().min(1).max(160),
  businessId: z.string().uuid().optional(),
});

