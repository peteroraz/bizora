import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sha256Hex } from "@bizora/auth";
import { enrollDeviceSchema, uuidSchema } from "@bizora/contracts";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { canManageBranchSettings } from "../../common/tenant-scope.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, shopDevices } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { EntitlementService } from "../entitlements/entitlement.service.js";
import { SessionService } from "../identity/session.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";

export type ShopDevice = typeof shopDevices.$inferSelect;

export type DeviceMeta = { ip?: string | null; userAgent?: string | null };

/**
 * Shop devices (Addendum v1.2 §6): an owner or manager turns on Shop mode on a phone or tablet
 * for one branch. The device gets a long random token in an httpOnly cookie; only its hash is stored.
 * Staff PIN sign-in is accepted only together with a valid, unrevoked, unsuspended device cookie.
 */
@Injectable()
export class ShopDeviceService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async enroll(tenant: TenantContext, raw: unknown, meta: DeviceMeta) {
    if (tenant.deviceId) {
      throw new ApiError("FORBIDDEN", "Sign in as the owner or a manager to turn on Shop mode.", 403);
    }
    const payload = enrollDeviceSchema.parse(raw);
    const branchId = tenant.membershipBranchId ?? payload.branchId ?? tenant.branchId;
    if (!branchId) {
      throw new ApiError("BRANCH_REQUIRED", "Choose the shop this device belongs to.", 400);
    }
    const branch = await this.tenants.findBranch(tenant.tenantId, branchId);
    if (!branch || !canManageBranchSettings(tenant, branch)) {
      throw new ApiError("FORBIDDEN", "That shop is outside your access.", 403);
    }
    await this.entitlements.assertWithinLimit(tenant.tenantId, "max_devices");

    const token = randomBytes(32).toString("base64url");
    const id = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(shopDevices).values({
        id,
        tenantId: tenant.tenantId,
        businessId: branch.businessId,
        branchId: branch.id,
        name: payload.name,
        tokenHash: sha256Hex(token),
        createdBy: tenant.userId,
        lastSeenAt: new Date(),
      });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "shop_device.enrolled",
          entityType: "shop_device",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: branch.businessId,
          branchId: branch.id,
          metadata: { name: payload.name },
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );
    });
    const device = await this.requireInScope(tenant, id);
    return { device: this.present(device, branch.name), token };
  }

  async list(tenant: TenantContext) {
    const rows = await this.db
      .select({ device: shopDevices, branchName: branches.name })
      .from(shopDevices)
      .innerJoin(branches, and(eq(branches.id, shopDevices.branchId), eq(branches.tenantId, shopDevices.tenantId)))
      .where(and(...this.scopeFilters(tenant)))
      .orderBy(desc(shopDevices.createdAt));
    return rows.map((row) => this.present(row.device, row.branchName));
  }

  async revoke(tenant: TenantContext, id: string, meta: DeviceMeta) {
    const device = await this.requireInScope(tenant, id);
    if (!device.revokedAt) {
      await this.db
        .update(shopDevices)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(shopDevices.id, device.id), eq(shopDevices.tenantId, tenant.tenantId)));
      await this.sessions.revokeAllForDevice(device.id);
      await this.audit.record({
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "shop_device.revoked",
        entityType: "shop_device",
        entityId: device.id,
        correlationId: tenant.correlationId,
        businessId: device.businessId,
        branchId: device.branchId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    return this.present(await this.requireInScope(tenant, id));
  }

  /** Re-approve a device that was suspended after too many wrong PINs. */
  async approve(tenant: TenantContext, id: string, meta: DeviceMeta) {
    const device = await this.requireInScope(tenant, id);
    if (device.revokedAt) {
      throw new ApiError("DEVICE_REVOKED", "This device was removed. Turn on Shop mode again on it.", 409);
    }
    const now = new Date();
    await this.db
      .update(shopDevices)
      .set({ suspendedAt: null, attemptsResetAt: now, updatedAt: now })
      .where(and(eq(shopDevices.id, device.id), eq(shopDevices.tenantId, tenant.tenantId)));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "shop_device.approved",
      entityType: "shop_device",
      entityId: device.id,
      correlationId: tenant.correlationId,
      businessId: device.businessId,
      branchId: device.branchId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.present(await this.requireInScope(tenant, id));
  }

  /** Owner/manager turns Shop mode off on the device they are using: the device is revoked. */
  async exitCurrent(tenant: TenantContext, deviceToken: string | null, meta: DeviceMeta) {
    if (!deviceToken) {
      throw new ApiError("NOT_A_SHOP_DEVICE", "Shop mode is not on for this device.", 400);
    }
    const [device] = await this.db
      .select()
      .from(shopDevices)
      .where(and(eq(shopDevices.tokenHash, sha256Hex(deviceToken)), eq(shopDevices.tenantId, tenant.tenantId)))
      .limit(1);
    if (!device) {
      throw new ApiError("NOT_A_SHOP_DEVICE", "Shop mode is not on for this device.", 400);
    }
    return this.revoke(tenant, device.id, meta);
  }

  /**
   * Resolve the device from its cookie for Shop-mode endpoints. Revoked or unknown devices get 401;
   * suspended devices get 423 so the screen can say "ask the owner to approve this device".
   */
  async resolve(deviceToken: string | null): Promise<ShopDevice> {
    if (!deviceToken) {
      throw new ApiError("DEVICE_REQUIRED", "Shop mode is not on for this device.", 401);
    }
    const [device] = await this.db
      .select()
      .from(shopDevices)
      .where(eq(shopDevices.tokenHash, sha256Hex(deviceToken)))
      .limit(1);
    if (!device || device.revokedAt) {
      throw new ApiError("DEVICE_REQUIRED", "Shop mode is not on for this device.", 401);
    }
    if (device.suspendedAt) {
      throw new ApiError("DEVICE_SUSPENDED", "Too many wrong PINs. Ask the owner to approve this device.", 423);
    }
    await this.db.update(shopDevices).set({ lastSeenAt: new Date() }).where(eq(shopDevices.id, device.id));
    return device;
  }

  present(device: ShopDevice, branchName?: string) {
    return {
      id: device.id,
      name: device.name,
      businessId: device.businessId,
      branchId: device.branchId,
      branchName: branchName ?? null,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      status: device.revokedAt ? "revoked" : device.suspendedAt ? "suspended" : "active",
    };
  }

  private scopeFilters(tenant: TenantContext): SQL[] {
    const filters: SQL[] = [eq(shopDevices.tenantId, tenant.tenantId)];
    if (tenant.membershipBranchId) filters.push(eq(shopDevices.branchId, tenant.membershipBranchId));
    else if (tenant.membershipBusinessId) filters.push(eq(shopDevices.businessId, tenant.membershipBusinessId));
    return filters;
  }

  private async requireInScope(tenant: TenantContext, id: string) {
    if (!uuidSchema.safeParse(id).success) {
      throw new ApiError("NOT_FOUND", "Device was not found.", 404);
    }
    const [device] = await this.db
      .select()
      .from(shopDevices)
      .where(and(eq(shopDevices.id, id), ...this.scopeFilters(tenant)))
      .limit(1);
    if (!device) {
      throw new ApiError("NOT_FOUND", "Device was not found.", 404);
    }
    return device;
  }

  /** Active (not revoked) devices on a branch — used by tests and the roster. */
  async activeForBranch(tenantId: string, branchId: string) {
    return this.db
      .select()
      .from(shopDevices)
      .where(and(eq(shopDevices.tenantId, tenantId), eq(shopDevices.branchId, branchId), isNull(shopDevices.revokedAt)));
  }
}
