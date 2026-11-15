import { Inject, Injectable } from "@nestjs/common";
import { hashPassword, verifyPassword } from "@bizora/auth";
import {
  PIN_LOCKOUT,
  createStaffSchema,
  isHigherPrivilege,
  pinLoginSchema,
  resetStaffPinSchema,
  uuidSchema,
} from "@bizora/contracts";
import { and, asc, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { canManageBranchSettings } from "../../common/tenant-scope.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, memberships, shopDevices, staffCredentials, staffPinAttempts, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { EntitlementService } from "../entitlements/entitlement.service.js";
import { SessionService } from "../identity/session.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";
import { ShopDeviceService, type DeviceMeta, type ShopDevice } from "./shop-device.service.js";

type Store = Pick<AppDatabase, "select" | "insert" | "update">;

type PinCheck =
  | { ok: true; membership: typeof memberships.$inferSelect }
  | { ok: false; code: "INVALID_PIN" | "STAFF_LOCKED" | "DEVICE_SUSPENDED"; minutes?: number; justSuspended?: boolean };

/**
 * Shop staff without email (Addendum v1.2 §6). Staff are users with kind = 'staff', no email and no
 * password, one membership (branch-scoped) and a PIN. PIN sign-in only works on an enrolled shop
 * device for the staff member's branch, with lockouts per staff member and per device.
 */
@Injectable()
export class StaffService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
    @Inject(ShopDeviceService) private readonly devices: ShopDeviceService,
  ) {}

  async list(tenant: TenantContext) {
    const rows = await this.db
      .select({
        membership: memberships,
        displayName: users.displayName,
        branchName: branches.name,
        pinUpdatedAt: staffCredentials.pinUpdatedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(staffCredentials, eq(staffCredentials.membershipId, memberships.id))
      .leftJoin(branches, and(eq(branches.id, memberships.branchId), eq(branches.tenantId, memberships.tenantId)))
      .where(and(eq(users.kind, "staff"), ...this.scopeFilters(tenant)))
      .orderBy(asc(users.displayName));
    return rows.map((row) => ({
      id: row.membership.id,
      displayName: row.displayName,
      role: row.membership.role,
      branchId: row.membership.branchId,
      branchName: row.branchName,
      phoneE164: row.membership.phoneE164 ?? null,
      status: row.membership.status === "ACTIVE" ? "active" : "inactive",
      pinUpdatedAt: row.pinUpdatedAt,
    }));
  }

  async create(tenant: TenantContext, raw: unknown, meta: DeviceMeta) {
    this.assertNotStaffSession(tenant);
    const payload = createStaffSchema.parse(raw);
    if (isHigherPrivilege(payload.role, tenant.role)) {
      throw new ApiError("ROLE_ESCALATION_FORBIDDEN", "You cannot give a role above your own.", 403);
    }
    const branch = await this.tenants.findBranch(tenant.tenantId, payload.branchId);
    if (!branch || !canManageBranchSettings(tenant, branch)) {
      throw new ApiError("FORBIDDEN", "That shop is outside your access.", 403);
    }
    await this.entitlements.assertWithinLimit(tenant.tenantId, "max_staff");

    const pinHash = await hashPassword(payload.pin);
    const userId = newId();
    const membershipId = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: null,
        passwordHash: null,
        displayName: payload.displayName,
        kind: "staff",
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await tx.insert(memberships).values({
        id: membershipId,
        tenantId: tenant.tenantId,
        userId,
        role: payload.role,
        businessId: branch.businessId,
        branchId: branch.id,
        status: "ACTIVE",
        phoneE164: payload.phoneE164 ?? null,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await tx.insert(staffCredentials).values({
        membershipId,
        tenantId: tenant.tenantId,
        userId,
        pinHash,
      });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "staff.created",
          entityType: "membership",
          entityId: membershipId,
          correlationId: tenant.correlationId,
          businessId: branch.businessId,
          branchId: branch.id,
          metadata: { role: payload.role },
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );
    });
    return this.requireStaff(tenant, membershipId).then((staff) => this.presentOne(staff));
  }

  async resetPin(tenant: TenantContext, membershipId: string, raw: unknown, meta: DeviceMeta) {
    this.assertNotStaffSession(tenant);
    const payload = resetStaffPinSchema.parse(raw);
    const staff = await this.requireStaff(tenant, membershipId);
    const now = new Date();
    await this.db
      .update(staffCredentials)
      .set({ pinHash: await hashPassword(payload.pin), pinUpdatedAt: now, attemptsResetAt: now, updatedAt: now })
      .where(and(eq(staffCredentials.membershipId, staff.membership.id), eq(staffCredentials.tenantId, tenant.tenantId)));
    await this.sessions.revokeAllForUser(staff.membership.userId);
    await this.record(tenant, "staff.pin_reset", staff.membership, meta);
    return this.presentOne(await this.requireStaff(tenant, membershipId));
  }

  async deactivate(tenant: TenantContext, membershipId: string, meta: DeviceMeta) {
    this.assertNotStaffSession(tenant);
    const staff = await this.requireStaff(tenant, membershipId);
    await this.db
      .update(memberships)
      .set({ status: "INACTIVE", updatedAt: new Date(), updatedBy: tenant.userId })
      .where(and(eq(memberships.id, staff.membership.id), eq(memberships.tenantId, tenant.tenantId)));
    await this.sessions.revokeAllForUser(staff.membership.userId);
    await this.record(tenant, "staff.deactivated", staff.membership, meta);
    return this.presentOne(await this.requireStaff(tenant, membershipId));
  }

  async reactivate(tenant: TenantContext, membershipId: string, meta: DeviceMeta) {
    this.assertNotStaffSession(tenant);
    const staff = await this.requireStaff(tenant, membershipId);
    if (staff.membership.status !== "ACTIVE") {
      await this.entitlements.assertWithinLimit(tenant.tenantId, "max_staff");
      await this.db
        .update(memberships)
        .set({ status: "ACTIVE", updatedAt: new Date(), updatedBy: tenant.userId })
        .where(and(eq(memberships.id, staff.membership.id), eq(memberships.tenantId, tenant.tenantId)));
      await this.record(tenant, "staff.reactivated", staff.membership, meta);
    }
    return this.presentOne(await this.requireStaff(tenant, membershipId));
  }

  /** Staff picker for an enrolled device: active PIN staff of the device's branch. */
  async roster(device: ShopDevice) {
    const rows = await this.db
      .select({ membership: memberships, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(staffCredentials, eq(staffCredentials.membershipId, memberships.id))
      .where(
        and(
          eq(memberships.tenantId, device.tenantId),
          eq(memberships.branchId, device.branchId),
          eq(memberships.status, "ACTIVE"),
          eq(users.kind, "staff"),
        ),
      )
      .orderBy(asc(users.displayName));
    const lockedUntil = await this.lockedUntilFor(
      device,
      rows.map((row) => row.membership.id),
    );
    return rows.map((row) => ({
      id: row.membership.id,
      displayName: row.displayName,
      role: row.membership.role,
      lockedUntil: lockedUntil.get(row.membership.id) ?? null,
    }));
  }

  async pinLogin(deviceToken: string | null, raw: unknown, meta: DeviceMeta & { correlationId: string }) {
    const device = await this.devices.resolve(deviceToken);
    const payload = pinLoginSchema.parse(raw);

    // Attempts are recorded inside the transaction and the error is thrown after commit,
    // so failed attempts are never rolled back. The device row lock serialises attempts per device.
    const result = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(shopDevices)
        .where(eq(shopDevices.id, device.id))
        .for("update")
        .limit(1);
      if (!locked || locked.revokedAt) {
        return { ok: false, code: "INVALID_PIN" } as PinCheck;
      }
      if (locked.suspendedAt) {
        return { ok: false, code: "DEVICE_SUSPENDED" } as PinCheck;
      }
      return this.checkPin(tx, locked, payload.staffId, payload.pin, meta);
    });

    if (!result.ok) {
      if (result.justSuspended) {
        // Outside the transaction: end every session on the suspended device.
        await this.sessions.revokeAllForDevice(device.id);
      }
      if (result.code === "DEVICE_SUSPENDED") {
        throw new ApiError("DEVICE_SUSPENDED", "Too many wrong PINs. Ask the owner to approve this device.", 423);
      }
      if (result.code === "STAFF_LOCKED") {
        throw new ApiError(
          "STAFF_LOCKED",
          `Too many wrong PINs. Try again in ${result.minutes ?? PIN_LOCKOUT.staffLockMinutes} minutes or ask the owner.`,
          423,
        );
      }
      throw new ApiError("INVALID_PIN", "That PIN is not correct.", 401);
    }

    const membership = result.membership;
    const tokens = await this.sessions.issue({
      userId: membership.userId,
      tenantId: device.tenantId,
      membershipId: membership.id,
      businessId: device.businessId,
      branchId: device.branchId,
      typ: "access",
      deviceId: device.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.audit.record({
      tenantId: device.tenantId,
      actorUserId: membership.userId,
      action: "identity.login",
      entityType: "user",
      entityId: membership.userId,
      correlationId: meta.correlationId,
      businessId: device.businessId,
      branchId: device.branchId,
      actorType: "STAFF_PIN",
      metadata: { method: "staff_pin", deviceId: device.id },
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      staff: { id: membership.id, role: membership.role },
      device: { id: device.id, branchId: device.branchId },
      autoLockMinutes: PIN_LOCKOUT.autoLockMinutesDefault,
    };
  }

  private async checkPin(
    tx: Store,
    device: ShopDevice,
    staffId: string,
    pin: string,
    meta: DeviceMeta & { correlationId: string },
  ): Promise<PinCheck> {
    const [row] = await tx
      .select({ membership: memberships, user: users, credential: staffCredentials })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(staffCredentials, eq(staffCredentials.membershipId, memberships.id))
      .where(
        and(
          eq(memberships.id, staffId),
          eq(memberships.tenantId, device.tenantId),
          eq(memberships.branchId, device.branchId),
          eq(memberships.status, "ACTIVE"),
          eq(users.kind, "staff"),
        ),
      )
      .limit(1);

    if (row) {
      const lockMinutes = await this.staffLockMinutes(tx, device, row.membership.id, row.credential.attemptsResetAt);
      if (lockMinutes > 0) {
        return { ok: false, code: "STAFF_LOCKED", minutes: lockMinutes };
      }
    }

    const valid = row ? await verifyPassword(row.credential.pinHash, pin) : false;
    await tx.insert(staffPinAttempts).values({
      id: newId(),
      tenantId: device.tenantId,
      deviceId: device.id,
      membershipId: row ? row.membership.id : null,
      succeeded: valid,
    });
    if (valid && row) {
      return { ok: true, membership: row.membership };
    }

    if (await this.deviceOverLimit(tx, device)) {
      const now = new Date();
      await tx.update(shopDevices).set({ suspendedAt: now, updatedAt: now }).where(eq(shopDevices.id, device.id));
      await this.audit.record(
        {
          tenantId: device.tenantId,
          action: "shop_device.suspended",
          entityType: "shop_device",
          entityId: device.id,
          correlationId: meta.correlationId,
          businessId: device.businessId,
          branchId: device.branchId,
          actorType: "SYSTEM",
          metadata: { reason: "too_many_failed_pins" },
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );
      return { ok: false, code: "DEVICE_SUSPENDED", justSuspended: true };
    }
    if (row) {
      const lockMinutes = await this.staffLockMinutes(tx, device, row.membership.id, row.credential.attemptsResetAt);
      if (lockMinutes > 0) {
        await this.audit.record(
          {
            tenantId: device.tenantId,
            actorUserId: row.membership.userId,
            action: "staff.locked",
            entityType: "membership",
            entityId: row.membership.id,
            correlationId: meta.correlationId,
            businessId: device.businessId,
            branchId: device.branchId,
            actorType: "STAFF_PIN",
            metadata: { deviceId: device.id },
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
          },
          tx,
        );
        return { ok: false, code: "STAFF_LOCKED", minutes: lockMinutes };
      }
    }
    await this.audit.record(
      {
        tenantId: device.tenantId,
        actorUserId: row?.membership.userId ?? null,
        action: "identity.pin_failed",
        entityType: "shop_device",
        entityId: device.id,
        correlationId: meta.correlationId,
        businessId: device.businessId,
        branchId: device.branchId,
        actorType: "STAFF_PIN",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return { ok: false, code: "INVALID_PIN" };
  }

  /**
   * Minutes left on a staff lock for this device, or 0. A staff member is locked when their last
   * `staffFailures` attempts on the device (since their last success or PIN reset) all failed and
   * the latest failure was less than `staffLockMinutes` ago.
   */
  private async staffLockMinutes(
    store: Pick<AppDatabase, "select">,
    device: ShopDevice,
    membershipId: string,
    resetAt: Date | null,
  ): Promise<number> {
    const filters: SQL[] = [eq(staffPinAttempts.deviceId, device.id), eq(staffPinAttempts.membershipId, membershipId)];
    if (resetAt) filters.push(gt(staffPinAttempts.createdAt, resetAt));
    const recent = await store
      .select()
      .from(staffPinAttempts)
      .where(and(...filters))
      .orderBy(desc(staffPinAttempts.createdAt))
      .limit(PIN_LOCKOUT.staffFailures);
    if (recent.length < PIN_LOCKOUT.staffFailures || recent.some((attempt) => attempt.succeeded)) return 0;
    const latest = recent[0]?.createdAt.getTime() ?? 0;
    const remainingMs = latest + PIN_LOCKOUT.staffLockMinutes * 60_000 - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : 0;
  }

  private async lockedUntilFor(device: ShopDevice, membershipIds: string[]) {
    const result = new Map<string, string>();
    if (membershipIds.length === 0) return result;
    const credentials = await this.db
      .select()
      .from(staffCredentials)
      .where(inArray(staffCredentials.membershipId, membershipIds));
    for (const credential of credentials) {
      const minutes = await this.staffLockMinutes(this.db, device, credential.membershipId, credential.attemptsResetAt);
      if (minutes > 0) {
        result.set(credential.membershipId, new Date(Date.now() + minutes * 60_000).toISOString());
      }
    }
    return result;
  }

  private async deviceOverLimit(store: Pick<AppDatabase, "select">, device: ShopDevice) {
    const windowStart = new Date(Date.now() - PIN_LOCKOUT.deviceWindowHours * 60 * 60_000);
    const since = device.attemptsResetAt && device.attemptsResetAt > windowStart ? device.attemptsResetAt : windowStart;
    const failures = await store
      .select({ id: staffPinAttempts.id })
      .from(staffPinAttempts)
      .where(
        and(
          eq(staffPinAttempts.deviceId, device.id),
          eq(staffPinAttempts.succeeded, false),
          gt(staffPinAttempts.createdAt, since),
        ),
      )
      .limit(PIN_LOCKOUT.deviceFailures);
    return failures.length >= PIN_LOCKOUT.deviceFailures;
  }

  private assertNotStaffSession(tenant: TenantContext) {
    if (tenant.deviceId) {
      throw new ApiError("FORBIDDEN", "Sign in as the owner or a manager to manage staff.", 403);
    }
  }

  private scopeFilters(tenant: TenantContext): SQL[] {
    const filters: SQL[] = [eq(memberships.tenantId, tenant.tenantId)];
    if (tenant.membershipBranchId) filters.push(eq(memberships.branchId, tenant.membershipBranchId));
    else if (tenant.membershipBusinessId) filters.push(eq(memberships.businessId, tenant.membershipBusinessId));
    return filters;
  }

  private async requireStaff(tenant: TenantContext, membershipId: string) {
    if (!uuidSchema.safeParse(membershipId).success) {
      throw new ApiError("NOT_FOUND", "Staff member was not found.", 404);
    }
    const [row] = await this.db
      .select({
        membership: memberships,
        displayName: users.displayName,
        branchName: branches.name,
        pinUpdatedAt: staffCredentials.pinUpdatedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(staffCredentials, eq(staffCredentials.membershipId, memberships.id))
      .leftJoin(branches, and(eq(branches.id, memberships.branchId), eq(branches.tenantId, memberships.tenantId)))
      .where(and(eq(memberships.id, membershipId), eq(users.kind, "staff"), ...this.scopeFilters(tenant)))
      .limit(1);
    if (!row) {
      throw new ApiError("NOT_FOUND", "Staff member was not found.", 404);
    }
    return row;
  }

  private presentOne(row: Awaited<ReturnType<StaffService["requireStaff"]>>) {
    return {
      id: row.membership.id,
      displayName: row.displayName,
      role: row.membership.role,
      branchId: row.membership.branchId,
      branchName: row.branchName,
      phoneE164: row.membership.phoneE164 ?? null,
      status: row.membership.status === "ACTIVE" ? "active" : "inactive",
      pinUpdatedAt: row.pinUpdatedAt,
    };
  }

  private async record(
    tenant: TenantContext,
    action: string,
    membership: typeof memberships.$inferSelect,
    meta: DeviceMeta,
  ) {
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action,
      entityType: "membership",
      entityId: membership.id,
      correlationId: tenant.correlationId,
      businessId: membership.businessId,
      branchId: membership.branchId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }
}
