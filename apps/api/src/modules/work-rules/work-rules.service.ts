import { Inject, Injectable } from "@nestjs/common";
import { hoursToday, isOpenAt, setOpeningHoursSchema, shopLockSchema, WORK_PERMIT_MAX_HOURS, workPermitSchema, type OpeningHours } from "@bizora/contracts";
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, memberships, users, workPermits } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";

export type WorkRefusal = { code: "SHOP_LOCKED" | "OUTSIDE_HOURS"; message: string };

/** Only the business owner, signed in as themselves (not on a shop device), works outside the rules. */
export const isOwner = (tenant: TenantContext) => tenant.role === "OWNER" && !tenant.deviceId;

/**
 * Shop locks, opening hours and permission to work outside them (ADR-034). The owner alone sets them. Outside the
 * hours, or in a locked shop, staff cannot change the books; reading stays open so they can still look things up.
 */
@Injectable()
export class WorkRulesService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** Why this person may not change the books right now (or at `at`), or null when they may. */
  async refusal(tenant: TenantContext, shopIds: (string | null | undefined)[], at = new Date()): Promise<WorkRefusal | null> {
    if (isOwner(tenant)) return null;
    const ids = [...new Set(shopIds.filter((id): id is string => Boolean(id)))];
    if (ids.length > 0) {
      const [locked] = await this.db
        .select({ name: branches.name, note: branches.lockNote })
        .from(branches)
        .where(and(eq(branches.tenantId, tenant.tenantId), inArray(branches.id, ids), lte(branches.lockedAt, at)))
        .limit(1);
      if (locked) {
        return { code: "SHOP_LOCKED", message: `The owner has locked ${locked.name}${locked.note ? ` (${locked.note})` : ""}. Only the owner can make changes there until it is unlocked.` };
      }
    }
    const businessId = tenant.businessId ?? tenant.membershipBusinessId;
    if (!businessId) return null;
    const [business] = await this.db
      .select({ hours: businesses.openingHours, timezone: businesses.timezone })
      .from(businesses)
      .where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, businessId)))
      .limit(1);
    if (!business?.hours || isOpenAt(business.hours, at, business.timezone)) return null;
    if (await this.permitUntil(this.db, tenant, at)) return null;
    const today = hoursToday(business.hours, at, business.timezone);
    const when = today ? `Opening hours today are ${today.open}–${today.close}.` : "The business is closed today.";
    return { code: "OUTSIDE_HOURS", message: `${when} Outside opening hours only the owner can make changes. Ask the owner to let you work now.` };
  }

  /** What the person signed in should know: open or closed, a lock on their shop, and any permission to work late. */
  async status(tenant: TenantContext) {
    const now = new Date();
    const businessId = tenant.businessId ?? tenant.membershipBusinessId;
    const [business] = businessId
      ? await this.db.select({ hours: businesses.openingHours, timezone: businesses.timezone }).from(businesses).where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, businessId))).limit(1)
      : [];
    const [shop] = tenant.branchId
      ? await this.db.select({ name: branches.name, lockedAt: branches.lockedAt, note: branches.lockNote }).from(branches).where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, tenant.branchId))).limit(1)
      : [];
    const permit = await this.permitUntil(this.db, tenant, now);
    const refusal = await this.refusal(tenant, [tenant.branchId], now);
    return {
      owner: isOwner(tenant),
      hasHours: Boolean(business?.hours),
      open: isOpenAt(business?.hours ?? null, now, business?.timezone ?? "UTC"),
      today: hoursToday(business?.hours ?? null, now, business?.timezone ?? "UTC"),
      locked: shop?.lockedAt ? { shop: shop.name, note: shop.note, since: shop.lockedAt.toISOString() } : null,
      permitUntil: permit?.toISOString() ?? null,
      blocked: refusal,
    };
  }

  /** The owner's settings page: hours, shop locks and who may work outside the hours. */
  async settings(tenant: TenantContext) {
    const business = await this.business(this.db, tenant);
    const shops = await this.db
      .select({ id: branches.id, name: branches.name, lockedAt: branches.lockedAt, lockNote: branches.lockNote })
      .from(branches)
      .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, business.id), isNull(branches.closedAt)))
      .orderBy(asc(branches.name));
    return {
      owner: isOwner(tenant),
      hours: business.openingHours ?? null,
      timezone: business.timezone,
      shops: shops.map((shop) => ({ id: shop.id, name: shop.name, lockedAt: shop.lockedAt?.toISOString() ?? null, lockNote: shop.lockNote })),
      permits: isOwner(tenant) ? await this.permits(tenant, business.id) : [],
    };
  }

  async setHours(tenant: TenantContext, raw: unknown) {
    this.assertOwner(tenant, "set opening hours");
    const { hours } = setOpeningHoursSchema.parse(raw);
    const business = await this.business(this.db, tenant);
    await this.db.transaction(async (tx) => {
      await tx.update(businesses).set({ openingHours: hours as OpeningHours | null, updatedAt: new Date() }).where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, business.id)));
      await this.record(tx, tenant, "business.hours_set", "business", business.id, business.id, null, { hours });
    });
    return this.settings(tenant);
  }

  async lock(tenant: TenantContext, branchId: string, raw: unknown) {
    this.assertOwner(tenant, "lock a shop");
    const { note } = shopLockSchema.parse(raw);
    const shop = await this.shop(tenant, branchId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(branches)
        .set({ lockedAt: new Date(), lockedBy: tenant.userId, lockNote: note || null, updatedAt: new Date() })
        .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, shop.id)));
      await this.record(tx, tenant, "branch.locked", "branch", shop.id, shop.businessId, shop.id, { name: shop.name, note: note || null });
    });
    return this.settings(tenant);
  }

  async unlock(tenant: TenantContext, branchId: string) {
    this.assertOwner(tenant, "unlock a shop");
    const shop = await this.shop(tenant, branchId);
    await this.db.transaction(async (tx) => {
      await tx.update(branches).set({ lockedAt: null, lockedBy: null, lockNote: null, updatedAt: new Date() }).where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, shop.id)));
      await this.record(tx, tenant, "branch.unlocked", "branch", shop.id, shop.businessId, shop.id, { name: shop.name });
    });
    return this.settings(tenant);
  }

  /** The owner lets one person work outside the opening hours, from now until a set time. */
  async grant(tenant: TenantContext, raw: unknown) {
    this.assertOwner(tenant, "let staff work outside opening hours");
    const payload = workPermitSchema.parse(raw);
    const business = await this.business(this.db, tenant);
    const now = new Date();
    const until = new Date(payload.until);
    if (until.getTime() <= now.getTime()) throw new ApiError("VALIDATION_ERROR", "Choose a time later than now.", 400, [{ field: "until", message: "Choose a later time." }]);
    if (until.getTime() - now.getTime() > WORK_PERMIT_MAX_HOURS * 3_600_000) {
      throw new ApiError("VALIDATION_ERROR", "Permission can last up to 14 days.", 400, [{ field: "until", message: "Up to 14 days." }]);
    }
    const [person] = await this.db
      .select({ id: memberships.id, role: memberships.role, name: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.id, payload.membershipId), eq(memberships.status, "ACTIVE")))
      .limit(1);
    if (!person) throw new ApiError("NOT_FOUND", "That person was not found.", 404);
    if (person.role === "OWNER") throw new ApiError("VALIDATION_ERROR", "Owners can always work.", 400);
    const id = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(workPermits).values({ id, tenantId: tenant.tenantId, businessId: business.id, membershipId: person.id, startsAt: now, endsAt: until, note: payload.note || null, createdBy: tenant.userId });
      await this.record(tx, tenant, "work.permitted", "membership", person.id, business.id, null, { name: person.name, until: until.toISOString(), note: payload.note || null });
    });
    return this.settings(tenant);
  }

  async revoke(tenant: TenantContext, permitId: string) {
    this.assertOwner(tenant, "stop permission to work");
    const [permit] = await this.db.select().from(workPermits).where(and(eq(workPermits.tenantId, tenant.tenantId), eq(workPermits.id, permitId))).limit(1);
    if (!permit) throw new ApiError("NOT_FOUND", "That permission was not found.", 404);
    if (!permit.revokedAt) {
      await this.db.transaction(async (tx) => {
        await tx.update(workPermits).set({ revokedAt: new Date(), revokedBy: tenant.userId }).where(and(eq(workPermits.tenantId, tenant.tenantId), eq(workPermits.id, permit.id)));
        await this.record(tx, tenant, "work.permit_stopped", "membership", permit.membershipId, permit.businessId, null, {});
      });
    }
    return this.settings(tenant);
  }

  /**
   * Work done with no network is accepted when it syncs, because it already happened. If it happened in a locked
   * shop or outside the hours, it is recorded in the activity log and the owner is told (ADR-034).
   */
  async flagOffline(tx: DbExecutor, tenant: TenantContext, refusal: WorkRefusal, what: { type: string; at: Date; shopId: string | null }) {
    await this.record(tx, tenant, "work.outside_rules", "sync", null, tenant.businessId, what.shopId, { rule: refusal.code, type: what.type, at: what.at.toISOString() });
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, tenant.userId)).limit(1);
    await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
      kind: refusal.code === "SHOP_LOCKED" ? "work.locked_offline" : "work.after_hours_offline",
      saleId: null,
      actorName: me?.name ?? null,
      data: { at: what.at.toISOString(), type: what.type },
    });
  }

  private async permitUntil(executor: DbExecutor, tenant: TenantContext, at: Date) {
    const [permit] = await executor
      .select({ endsAt: workPermits.endsAt })
      .from(workPermits)
      .where(and(eq(workPermits.tenantId, tenant.tenantId), eq(workPermits.membershipId, tenant.membershipId), isNull(workPermits.revokedAt), lte(workPermits.startsAt, at), gt(workPermits.endsAt, at)))
      .orderBy(asc(workPermits.endsAt))
      .limit(1);
    return permit?.endsAt ?? null;
  }

  private async permits(tenant: TenantContext, businessId: string) {
    const rows = await this.db
      .select({ id: workPermits.id, membershipId: workPermits.membershipId, name: users.displayName, role: memberships.role, endsAt: workPermits.endsAt, note: workPermits.note })
      .from(workPermits)
      .innerJoin(memberships, and(eq(memberships.tenantId, workPermits.tenantId), eq(memberships.id, workPermits.membershipId)))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(workPermits.tenantId, tenant.tenantId), eq(workPermits.businessId, businessId), isNull(workPermits.revokedAt), gt(workPermits.endsAt, new Date())))
      .orderBy(asc(workPermits.endsAt));
    return rows.map((row) => ({ id: row.id, membershipId: row.membershipId, name: row.name, role: row.role, until: row.endsAt.toISOString(), note: row.note }));
  }

  private async business(executor: DbExecutor, tenant: TenantContext) {
    const businessId = tenant.businessId ?? tenant.membershipBusinessId;
    if (!businessId) throw new ApiError("BUSINESS_REQUIRED", "Choose a business first.", 400);
    const [business] = await executor.select().from(businesses).where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, businessId))).limit(1);
    if (!business) throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    return business;
  }

  private async shop(tenant: TenantContext, branchId: string) {
    const business = await this.business(this.db, tenant);
    const [shop] = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, business.id), eq(branches.id, branchId), isNull(branches.closedAt)))
      .limit(1);
    if (!shop) throw new ApiError("NOT_FOUND", "Shop not found.", 404);
    return shop;
  }

  private assertOwner(tenant: TenantContext, what: string) {
    if (!isOwner(tenant)) throw new ApiError("FORBIDDEN", `Only the owner can ${what}.`, 403);
  }

  private async record(tx: DbExecutor, tenant: TenantContext, action: string, entityType: string, entityId: string | null, businessId: string | null, branchId: string | null, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType, entityId, correlationId: tenant.correlationId, businessId, branchId, metadata },
      tx,
    );
  }
}

