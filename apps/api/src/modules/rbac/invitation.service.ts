import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { hashPassword, sha256Hex } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  isHigherPrivilege,
  roleSchema,
} from "@bizora/contracts";
import { and, eq, gt } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import { resolveAssignableScope } from "../../common/tenant-scope.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { invitations, memberships, users } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";

@Injectable()
export class InvitationService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async invite(tenant: TenantContext, raw: unknown) {
    const payload = createInvitationSchema.parse(raw);
    if (isHigherPrivilege(payload.role, tenant.role)) {
      throw new ApiError("ROLE_ESCALATION_FORBIDDEN", "You cannot invite a role above your own.", 403);
    }

    const scoped = await this.resolveInviteScope(tenant, payload.businessId, payload.branchId);
    const businessId = await this.assertBusiness(tenant, scoped.businessId);
    const branchId = await this.assertBranch(tenant, scoped.branchId, businessId);

    const email = payload.email.toLowerCase();
    const existingUser = await this.findUserByEmail(email);
    if (existingUser) {
      const existingMembership = await this.tenants.findMembership(tenant.tenantId, existingUser.id);
      if (existingMembership) {
        throw new ApiError("ALREADY_MEMBER", "That user already belongs to this workspace.", 409);
      }
    }

    const [pending] = await this.db
      .select()
      .from(invitations)
      .where(
        and(eq(invitations.tenantId, tenant.tenantId), eq(invitations.email, email), eq(invitations.status, "PENDING")),
      )
      .limit(1);
    if (pending) {
      throw new ApiError("DUPLICATE_INVITATION", "A pending invitation already exists for that email.", 409);
    }

    const token = randomBytes(32).toString("base64url");
    const id = newId();
    await this.db.insert(invitations).values({
      id,
      tenantId: tenant.tenantId,
      email,
      role: payload.role,
      businessId,
      branchId,
      tokenHash: sha256Hex(token),
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
      businessId,
      branchId,
      metadata: { email, role: payload.role },
    });

    return this.publicInvitation({ id, email, role: payload.role, businessId, branchId }, token);
  }

  list(tenantId: string) {
    return this.db.select().from(invitations).where(eq(invitations.tenantId, tenantId));
  }

  async revoke(tenant: TenantContext, invitationId: string) {
    const [updated] = await this.db
      .update(invitations)
      .set({ status: "REVOKED", updatedBy: tenant.userId })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenant.tenantId),
          eq(invitations.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ApiError("INVITATION_NOT_FOUND", "Invitation was not found.", 404);
    }
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: invitationId,
      correlationId: tenant.correlationId,
    });
    return { id: updated.id, status: updated.status };
  }

  async resend(tenant: TenantContext, invitationId: string) {
    const token = randomBytes(32).toString("base64url");
    const [updated] = await this.db
      .update(invitations)
      .set({
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        updatedBy: tenant.userId,
      })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenant.tenantId),
          eq(invitations.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ApiError("INVITATION_NOT_FOUND", "Invitation was not found.", 404);
    }
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "invitation.resent",
      entityType: "invitation",
      entityId: updated.id,
      correlationId: tenant.correlationId,
      businessId: updated.businessId,
      branchId: updated.branchId,
    });
    return this.publicInvitation(
      { id: updated.id, email: updated.email, role: updated.role, businessId: updated.businessId, branchId: updated.branchId },
      token,
    );
  }

  async accept(raw: unknown, correlationId: string) {
    const payload = acceptInvitationSchema.parse(raw);
    const tokenHash = sha256Hex(payload.token);
    const passwordHash = payload.password ? await hashPassword(payload.password) : null;

    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .update(invitations)
        .set({ status: "ACCEPTED", updatedAt: new Date() })
        .where(
          and(
            eq(invitations.tokenHash, tokenHash),
            eq(invitations.status, "PENDING"),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!invitation) {
        throw new ApiError("INVITATION_INVALID", "Invitation is invalid, expired, or already used.", 400);
      }

      let user = (
        await tx.select().from(users).where(eq(users.email, invitation.email)).limit(1)
      )[0];
      if (!user) {
        if (!passwordHash) {
          throw new ApiError("PASSWORD_REQUIRED", "A password is required to create your account.", 400);
        }
        const userId = newId();
        await tx.insert(users).values({
          id: userId,
          email: invitation.email,
          passwordHash,
          displayName: payload.displayName,
          createdBy: userId,
          updatedBy: userId,
        });
        user = (await tx.select().from(users).where(eq(users.id, userId)).limit(1))[0];
      }
      if (!user) {
        throw new ApiError("USER_CREATE_FAILED", "Unable to create the invited user.", 500);
      }

      const [existingMembership] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, invitation.tenantId), eq(memberships.userId, user.id)))
        .limit(1);
      if (existingMembership) {
        throw new ApiError("ALREADY_MEMBER", "That user already belongs to this workspace.", 409);
      }

      const membershipId = newId();
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
        .set({ acceptedBy: user.id, updatedBy: user.id })
        .where(and(eq(invitations.id, invitation.id), eq(invitations.tenantId, invitation.tenantId)));

      return {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        tenantId: invitation.tenantId,
        membershipId,
        role: roleSchema.parse(invitation.role),
        businessId: invitation.businessId,
        branchId: invitation.branchId,
      };
    }).then(async (result) => {
      await this.audit.record({
        tenantId: result.tenantId,
        actorUserId: result.user.id,
        action: "invitation.accepted",
        entityType: "membership",
        entityId: result.membershipId,
        correlationId,
        businessId: result.businessId,
        branchId: result.branchId,
      });
      return {
        user: result.user,
        tenantId: result.tenantId,
        membershipId: result.membershipId,
        role: result.role,
      };
    });
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

  private publicInvitation(
    invitation: { id: string; email: string; role: string; businessId: string | null; branchId: string | null },
    token: string,
  ) {
    return {
      ...invitation,
      token: this.env.INVITE_TOKEN_EXPOSE ? token : undefined,
      inviteUrl: this.env.INVITE_TOKEN_EXPOSE ? `/invite?token=${token}` : undefined,
    };
  }

  private async resolveInviteScope(tenant: TenantContext, requestedBusinessId?: string, requestedBranchId?: string) {
    const scoped = resolveAssignableScope(tenant, { businessId: requestedBusinessId, branchId: requestedBranchId });
    if (scoped.branchId && !scoped.businessId) {
      const branch = await this.tenants.findBranch(tenant.tenantId, scoped.branchId);
      if (!branch) {
        throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
      }
      if (tenant.membershipBusinessId && branch.businessId !== tenant.membershipBusinessId) {
        throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
      }
      return { businessId: branch.businessId, branchId: scoped.branchId };
    }
    return scoped;
  }

  private async assertBusiness(tenant: TenantContext, businessId: string | null) {
    if (!businessId) return null;
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    return businessId;
  }

  private async assertBranch(tenant: TenantContext, branchId: string | null, businessId: string | null) {
    if (!branchId) return null;
    const branch = await this.tenants.findBranch(tenant.tenantId, branchId);
    if (!branch) {
      throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
    }
    if (businessId && branch.businessId !== businessId) {
      throw new ApiError("FORBIDDEN", "Branch does not belong to the selected business.", 403);
    }
    if (tenant.membershipBusinessId && branch.businessId !== tenant.membershipBusinessId) {
      throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
    }
    return branchId;
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
