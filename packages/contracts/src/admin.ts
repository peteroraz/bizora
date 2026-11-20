import { z } from "zod";

/**
 * The Admin portal (ADR-037): Bizora's own staff, never business users. Each role grants a set of abilities;
 * a person may hold several roles. Super admins manage staff; nobody can remove the last super admin.
 */
export const ADMIN_ROLES = ["super_admin", "support", "operations", "finance", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ABILITIES = {
  /** Find businesses and see their account details (never their sales or money). */
  "businesses.read": ["super_admin", "support", "operations", "finance", "viewer"],
  /** Find people and see their sign-in details. */
  "people.read": ["super_admin", "support", "operations", "finance", "viewer"],
  /** Resend invitations and verification emails, sign someone out everywhere. */
  "support.act": ["super_admin", "support", "operations"],
  /** Stop a lost or stolen shop phone. */
  "devices.stop": ["super_admin", "support", "operations"],
  /** Read what Bizora staff did. */
  "audit.read": ["super_admin", "operations"],
  /** Add, change and remove Bizora staff. */
  "staff.manage": ["super_admin"],
} as const satisfies Record<string, readonly AdminRole[]>;
export type AdminAbility = keyof typeof ADMIN_ABILITIES;

export function adminCan(roles: readonly string[], ability: AdminAbility): boolean {
  const allowed = ADMIN_ABILITIES[ability] as readonly string[];
  return roles.some((role) => allowed.includes(role));
}

export function adminAbilities(roles: readonly string[]): AdminAbility[] {
  return (Object.keys(ADMIN_ABILITIES) as AdminAbility[]).filter((ability) => adminCan(roles, ability));
}

export const adminRoleSchema = z.enum(ADMIN_ROLES);

/** Every support action needs a short reason, kept in both audit logs. */
export const adminReasonSchema = z.object({
  reason: z.string().trim().min(5, "Say why, in a few words.").max(500),
});

export const adminStaffAddSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(160),
  roles: z.array(adminRoleSchema).min(1).max(ADMIN_ROLES.length),
});

export const adminStaffRolesSchema = z.object({
  roles: z.array(adminRoleSchema).min(1).max(ADMIN_ROLES.length),
  reason: adminReasonSchema.shape.reason,
});

export const adminSearchSchema = z.object({
  q: z.string().trim().max(120).default(""),
});

export type AdminStaffAddInput = z.infer<typeof adminStaffAddSchema>;
