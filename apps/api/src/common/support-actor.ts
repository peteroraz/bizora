/**
 * A Bizora staff member acting on a business from the Admin portal (ADR-037). Recorded in the business's own
 * audit events as BIZORA_SUPPORT, with the staff email and reason, so the owner can see who did what and why.
 */
export type SupportActor = {
  staffId: string;
  staffEmail: string;
  reason: string;
  correlationId: string;
  ip?: string | null;
  userAgent?: string | null;
};

export function supportAuditFields(actor: SupportActor) {
  return {
    actorUserId: null,
    actorType: "BIZORA_SUPPORT" as const,
    source: "ADMIN_PORTAL",
    correlationId: actor.correlationId,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    metadata: { staffEmail: actor.staffEmail, reason: actor.reason },
  };
}
