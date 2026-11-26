import { Inject, Injectable } from "@nestjs/common";
import { adminReasonSchema, adminSuspendSchema, HOLD_REVIEW_DAYS, LIFECYCLE_SIGN_IN_MINUTES, TWO_PERSON_HOLD_REASONS, type HoldReason } from "@bizora/contracts";
import { and, desc, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import { supportAuditFields, type SupportActor } from "../../common/support-actor.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { businessLifecycleEvents, memberships, organizations } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { AdminAuditService } from "./admin-audit.service.js";
import type { AdminStaffMember } from "./admin-session.service.js";

function invalid(error: { issues: { path: PropertyKey[]; message: string }[] }): never {
  throw new ApiError("VALIDATION_FAILED", "Choose a reason and say why, in a few words.", 400, error.issues.map((issue) => ({ field: String(issue.path[0] ?? "form"), message: issue.message })));
}

/**
 * Bizora suspends and reinstates a business (ADR-071). Only `bizora_hold` changes: an owner's own choices are never
 * touched. The tenant guard enforces it on every request; this service changes it, logs it three ways (the lifecycle
 * events, the staff log, the business's own log) and tells the owner.
 */
@Injectable()
export class AdminLifecycleService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminAuditService) private readonly adminAudit: AdminAuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** The state and the full history, for the portal. Notes are shown to Bizora staff only. */
  async state(tenantId: string) {
    const [organization] = await this.db
      .select({ id: organizations.id, hold: organizations.bizoraHold, reasonCode: organizations.holdReasonCode, since: organizations.holdSince })
      .from(organizations)
      .where(eq(organizations.id, tenantId))
      .limit(1);
    if (!organization) throw new ApiError("NOT_FOUND", "Business not found.", 404);
    const events = await this.db.select().from(businessLifecycleEvents).where(eq(businessLifecycleEvents.tenantId, tenantId)).orderBy(desc(businessLifecycleEvents.createdAt)).limit(100);
    const current = organization.hold === "suspended" ? events.find((event) => event.toValue === "suspended") : undefined;
    return {
      hold: organization.hold,
      reasonCode: organization.reasonCode,
      since: organization.since?.toISOString() ?? null,
      reviewOn: current?.reviewOn ?? null,
      suspendedBy: current?.actorStaffEmail ?? null,
      events: events.map((event) => ({
        id: event.id,
        from: event.fromValue,
        to: event.toValue,
        reasonCode: event.reasonCode,
        note: event.note,
        caseRef: event.caseRef,
        reviewOn: event.reviewOn,
        by: event.actorStaffEmail,
        at: event.createdAt.toISOString(),
      })),
    };
  }

  async suspend(tenantId: string, raw: unknown, admin: AdminStaffMember, actor: Omit<SupportActor, "reason">) {
    this.assertRecentSignIn(admin);
    const parsed = adminSuspendSchema.safeParse(raw ?? {});
    if (!parsed.success) invalid(parsed.error);
    const input = parsed.data;
    const reviewOn = input.reviewOn ?? new Date(Date.now() + HOLD_REVIEW_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (reviewOn <= new Date().toISOString().slice(0, 10)) {
      throw new ApiError("VALIDATION_FAILED", "Choose a review date after today.", 400, [{ field: "reviewOn", message: "After today." }]);
    }
    await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, tenantId);
      if (current.hold === "suspended") throw new ApiError("ALREADY_SUSPENDED", "This business is already suspended.", 409);
      const now = new Date();
      await tx.update(organizations).set({ bizoraHold: "suspended", holdReasonCode: input.reasonCode, holdSince: now }).where(eq(organizations.id, tenantId));
      await tx.insert(businessLifecycleEvents).values({
        id: newId(),
        tenantId,
        field: "bizora_hold",
        fromValue: "none",
        toValue: "suspended",
        reasonCode: input.reasonCode,
        note: input.reason,
        caseRef: input.caseRef || null,
        reviewOn,
        actorStaffId: admin.staffId,
        actorStaffEmail: admin.email,
      });
      // The business's own log says what happened and the category, never the note.
      await this.audit.record(
        { ...supportAuditFields({ ...actor, reason: input.reasonCode }), tenantId, action: "business.suspended", entityType: "organization", entityId: tenantId, metadata: { reasonCode: input.reasonCode } },
        tx,
      );
      await this.notifyOwners(tx, tenantId, "business.suspended", { reasonCode: input.reasonCode });
    });
    await this.adminAudit.record({
      staffId: admin.staffId,
      staffEmail: admin.email,
      action: "business.suspended",
      targetType: "business",
      targetId: tenantId,
      tenantId,
      reason: input.reason,
      metadata: { reasonCode: input.reasonCode, caseRef: input.caseRef ?? null, reviewOn },
      ip: actor.ip ?? null,
    });
    return this.state(tenantId);
  }

  async reinstate(tenantId: string, raw: unknown, admin: AdminStaffMember, actor: Omit<SupportActor, "reason">) {
    this.assertRecentSignIn(admin);
    const parsed = adminReasonSchema.safeParse(raw ?? {});
    if (!parsed.success) invalid(parsed.error);
    const note = parsed.data.reason;
    let reasonCode: string | null = null;
    await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, tenantId);
      if (current.hold !== "suspended") throw new ApiError("NOT_SUSPENDED", "This business is not suspended.", 409);
      reasonCode = current.reasonCode;
      const [suspended] = await tx
        .select({ staffId: businessLifecycleEvents.actorStaffId })
        .from(businessLifecycleEvents)
        .where(and(eq(businessLifecycleEvents.tenantId, tenantId), eq(businessLifecycleEvents.toValue, "suspended")))
        .orderBy(desc(businessLifecycleEvents.createdAt))
        .limit(1);
      if (TWO_PERSON_HOLD_REASONS.includes(current.reasonCode as HoldReason) && suspended?.staffId === admin.staffId) {
        throw new ApiError("SECOND_PERSON_NEEDED", "You suspended this business for fraud or security. Someone else must lift it.", 403);
      }
      await tx.update(organizations).set({ bizoraHold: "none", holdReasonCode: null, holdSince: null }).where(eq(organizations.id, tenantId));
      await tx.insert(businessLifecycleEvents).values({
        id: newId(),
        tenantId,
        field: "bizora_hold",
        fromValue: "suspended",
        toValue: "none",
        reasonCode: current.reasonCode,
        note,
        actorStaffId: admin.staffId,
        actorStaffEmail: admin.email,
      });
      await this.audit.record(
        { ...supportAuditFields({ ...actor, reason: "reinstated" }), tenantId, action: "business.reinstated", entityType: "organization", entityId: tenantId, metadata: {} },
        tx,
      );
      await this.notifyOwners(tx, tenantId, "business.reinstated", {});
    });
    await this.adminAudit.record({
      staffId: admin.staffId,
      staffEmail: admin.email,
      action: "business.reinstated",
      targetType: "business",
      targetId: tenantId,
      tenantId,
      reason: note,
      metadata: { reasonCode },
      ip: actor.ip ?? null,
    });
    return this.state(tenantId);
  }

  /** Serious, hard-to-undo actions need a fresh sign-in, so an unattended portal tab cannot be used for them. */
  private assertRecentSignIn(admin: AdminStaffMember) {
    if (Date.now() - admin.signedInAt.getTime() > LIFECYCLE_SIGN_IN_MINUTES * 60_000) {
      throw new ApiError("SIGN_IN_AGAIN", `Sign in again to do this: your sign-in must be less than ${LIFECYCLE_SIGN_IN_MINUTES} minutes old.`, 403);
    }
  }

  /** Locks the business row so two staff acting at once cannot both change it. */
  private async lock(tx: DbExecutor, tenantId: string) {
    const [row] = await tx
      .select({ hold: organizations.bizoraHold, reasonCode: organizations.holdReasonCode })
      .from(organizations)
      .where(eq(organizations.id, tenantId))
      .for("update")
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Business not found.", 404);
    return row;
  }

  private async notifyOwners(tx: DbExecutor, tenantId: string, kind: "business.suspended" | "business.reinstated", data: Record<string, unknown>) {
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    await this.notifications.notify(tx, tenantId, owners.map((row) => row.id), { kind, saleId: null, actorName: "Bizora", data });
  }
}
