import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { hashPassword } from "@bizora/auth";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  roleSchema,
} from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { invitations, memberships, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class InvitationService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async invite(tenant: TenantContext, raw: unknown) {
    const payload = createInvitationSchema.parse(raw);
    if (payload.role === "OWNER") {
      throw new ApiError("OWNER_INVITE_FORBIDDEN", "Owner membership cannot be granted by invitation.", 403);
    }
    if (payload.businessId) {
      const business = await this.tenants.findBusiness(tenant.tenantId, payload.businessId);
      if (!business) {
        throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
      }
    }
    if (payload.branchId) {
      const branch = await this.tenants.findVisibleBranch(tenant, payload.branchId);
      if (!branch) {
        throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
      }
    }

    const email = payload.email.toLowerCase();
    const existingUser = await this.findUserByEmail(email);
    if (existingUser) {
      const existingMembership = await this.tenants.findMembership(tenant.tenantId, existingUser.id);
      if (existingMembership) {
        throw new ApiError("ALREADY_MEMBER", "That user already belongs to this workspace.", 409);
      }
    }

    const token = randomBytes(32).toString("base64url");
    const id = newId();
    await this.db.insert(invitations).values({
      id,
      tenantId: tenant.tenantId,
      email,
      role: payload.role,
      businessId: payload.businessId ?? tenant.membershipBusinessId ?? tenant.businessId,
      branchId: payload.branchId ?? tenant.membershipBranchId ?? null,
      tokenHash: hashToken(token),
      status: "PENDING",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedBy: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    });

    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "users.invited",
      entityType: "invitation",
      entityId: id,
      correlationId: tenant.correlationId,
      metadata: { email, role: payload.role },
    });

    return { id, email, role: payload.role, token };
  }

  list(tenantId: string) {
    return this.db.select().from(invitations).where(eq(invitations.tenantId, tenantId));
  }

  async accept(raw: unknown, correlationId: string) {
    const payload = acceptInvitationSchema.parse(raw);
    const tokenHash = hashToken(payload.token);
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    if (!invitation || invitation.status !== "PENDING") {
      throw new ApiError("INVITATION_INVALID", "Invitation is invalid or already used.", 400);
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new ApiError("INVITATION_EXPIRED", "Invitation has expired.", 400);
    }

    let user = await this.findUserByEmail(invitation.email);
    if (!user) {
      if (!payload.password) {
        throw new ApiError("PASSWORD_REQUIRED", "A password is required to create your account.", 400);
      }
      const userId = newId();
      await this.db.insert(users).values({
        id: userId,
        email: invitation.email,
        passwordHash: await hashPassword(payload.password),
        displayName: payload.displayName,
        createdBy: userId,
        updatedBy: userId,
      });
      user = await this.findUserById(userId);
    }
    if (!user) {
      throw new ApiError("USER_CREATE_FAILED", "Unable to create the invited user.", 500);
    }

    const existingMembership = await this.tenants.findMembership(invitation.tenantId, user.id);
    if (existingMembership) {
      throw new ApiError("ALREADY_MEMBER", "That user already belongs to this workspace.", 409);
    }

    const membershipId = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: membershipId,
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.role,
        businessId: invitation.businessId,
        branchId: invitation.branchId,
        status: "ACTIVE",
        createdBy: user.id,
        updatedBy: user.id,
      });
      await tx
        .update(invitations)
        .set({ status: "ACCEPTED", acceptedBy: user.id, updatedBy: user.id })
        .where(and(eq(invitations.id, invitation.id), eq(invitations.tenantId, invitation.tenantId)));
    });

    await this.audit.record({
      tenantId: invitation.tenantId,
      actorUserId: user.id,
      action: "invitation.accepted",
      entityType: "membership",
      entityId: membershipId,
      correlationId,
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenantId: invitation.tenantId,
      membershipId,
      role: roleSchema.parse(invitation.role),
    };
  }

  async listPeople(tenantId: string) {
    const rows = await this.tenants.listMemberships(tenantId);
    const result = [];
    for (const membership of rows) {
      const user = await this.findUserById(membership.userId);
      result.push({
        membershipId: membership.id,
        userId: membership.userId,
        email: user?.email ?? null,
        displayName: user?.displayName ?? null,
        role: membership.role,
        businessId: membership.businessId,
        branchId: membership.branchId,
        status: membership.status,
      });
    }
    return result;
  }

  private async findUserByEmail(email: string) {
    const [row] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return row ?? null;
  }

  private async findUserById(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }
}
