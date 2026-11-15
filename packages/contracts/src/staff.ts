import { z } from "zod";
import { optionalPhoneSchema } from "./address.js";

/**
 * Roles that can be given to shop staff created without email (PIN on an enrolled shop device).
 * UI labels (Addendum v1.2 §5): SALES = "Sales staff", INVENTORY = "Storekeeper",
 * CASHIER = "Cashier", EMPLOYEE = "Shop helper". Managers, accountants and owners sign in with
 * email or Google and are invited the normal way.
 */
export const STAFF_ROLES = ["SALES", "CASHIER", "INVENTORY", "EMPLOYEE"] as const;
export const staffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRoleSchema>;


/** Rejects PINs that are trivially guessed: all the same digit, or straight runs like 1234 / 9876. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = pin.split("").map(Number);
  const ascending = digits.every((digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 1) % 10);
  const descending = digits.every((digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 9) % 10);
  return ascending || descending;
}

export const pinSchema = z
  .string()
  .regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits.")
  .refine((pin) => !isWeakPin(pin), "Choose a PIN that is harder to guess.");

export const createStaffSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  role: staffRoleSchema,
  branchId: z.string().uuid(),
  phoneE164: optionalPhoneSchema,
  pin: pinSchema,
});

export const resetStaffPinSchema = z.object({
  pin: pinSchema,
});

export const enrollDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  branchId: z.string().uuid().optional(),
});

export const pinLoginSchema = z.object({
  staffId: z.string().uuid(),
  // Do not apply the weak-PIN rule here: a login only checks the stored hash.
  pin: z.string().regex(/^\d{4,6}$/),
});

/** Lockout policy (Addendum v1.2 §6). */
export { PIN_LOCKOUT, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "./constants.js";

export const planFeatureSchema = z.enum(["multi_currency", "whatsapp_automation", "advanced_reports", "ai", "integrations"]);
export type PlanFeature = z.infer<typeof planFeatureSchema>;

export const planLimitSchema = z.enum(["max_branches", "max_staff", "max_devices"]);
export type PlanLimit = z.infer<typeof planLimitSchema>;

export const planLimitsSchema = z.object({
  max_branches: z.number().int().positive(),
  max_staff: z.number().int().nonnegative(),
  max_devices: z.number().int().nonnegative(),
  features: z.object({
    multi_currency: z.boolean().default(false),
    whatsapp_automation: z.boolean().default(false),
    advanced_reports: z.boolean().default(false),
    ai: z.boolean().default(false),
    integrations: z.boolean().default(false),
  }),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;
