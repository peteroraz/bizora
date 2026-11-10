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
