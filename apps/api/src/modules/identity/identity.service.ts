import { Inject, Injectable } from "@nestjs/common";
import { hashPassword, verifyPassword } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import {
  changePasswordSchema,
  loginRequestSchema,
  registerRequestSchema,
  selectContextRequestSchema,
  type RegisterRequest,
  type Role,
  type WorkspaceOption,
} from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId, slugify } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, businesses, memberships, organizations, users } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";
import { SessionService, type IssuedTokens } from "./session.service.js";

export type AuthMeta = { correlationId: string; ip?: string | null; userAgent?: string | null };

export type AuthPayload = {
  user: { id: string; email: string; displayName: string };
  needsWorkspaceSelection: boolean;
  workspaces: WorkspaceOption[];
  accessToken: string | null;
  refreshToken: string | null;
  tenant: {
    tenantId: string;
    businessId: string | null;
    branchId: string | null;
    membershipId: string;
    role: string;
  } | null;
};

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async register(input: RegisterRequest, meta: AuthMeta): Promise<AuthPayload> {
    const payload = registerRequestSchema.parse(input);
    const existing = await this.findUserByEmail(payload.email);
    if (existing) {
      throw new ApiError("EMAIL_IN_USE", "An account with this email already exists.", 409);
    }

    const userId = newId();
    const tenantId = newId();
    const businessId = newId();
    const branchId = newId();
    const membershipId = newId();
    const passwordHash = await hashPassword(payload.password);
    const slug = `${slugify(payload.organizationName) || "org"}-${tenantId.slice(0, 8)}`;

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: payload.email.toLowerCase(),
        passwordHash,
        displayName: payload.displayName,
        createdBy: userId,
        updatedBy: userId,
      });
      await tx.insert(organizations).values({
        id: tenantId,
        name: payload.organizationName,
        slug,
        createdBy: userId,
        updatedBy: userId,
      });
      await tx.insert(businesses).values({
        id: businessId,
        tenantId,
        name: payload.organizationName,
        countryCode: payload.countryCode,
        baseCurrencyCode: payload.baseCurrencyCode,
        timezone: payload.timezone,
        industryCode: payload.industryCode ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      await tx.insert(branches).values({
        id: branchId,
        tenantId,
        businessId,
        name: "Main",
        createdBy: userId,
        updatedBy: userId,
      });
      await tx.insert(memberships).values({
        id: membershipId,
        tenantId,
        userId,
        role: "OWNER",
        businessId: null,
        branchId: null,
        status: "ACTIVE",
        createdBy: userId,
        updatedBy: userId,
      });
    });

    await this.audit.record({
      tenantId,
      actorUserId: userId,
      action: "identity.register",
      entityType: "organization",
      entityId: tenantId,
      correlationId: meta.correlationId,
      businessId,
      branchId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueWorkspaceSession({
      userId,
      email: payload.email.toLowerCase(),
      displayName: payload.displayName,
      tenantId,
      businessId,
      branchId,
      membershipId,
      role: "OWNER",
      meta,
    });
  }

  async login(raw: unknown, meta: AuthMeta): Promise<AuthPayload> {
    const payload = loginRequestSchema.parse(raw);
    const user = await this.findUserByEmail(payload.email);
    if (!user || !(await verifyPassword(user.passwordHash, payload.password))) {
      throw new ApiError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
    }

    const workspaces = await this.listWorkspaces(user.id);
    if (workspaces.length === 0) {
      throw new ApiError("NO_MEMBERSHIP", "This user has no tenant membership.", 403);
    }

    const only = workspaces[0];
    await this.audit.record({
      tenantId: workspaces.length === 1 && only ? only.organizationId : null,
      actorUserId: user.id,
      action: "identity.login",
      entityType: "user",
      entityId: user.id,
      correlationId: meta.correlationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    if (workspaces.length > 1) {
      const tokens = await this.sessions.issue({
        userId: user.id,
        tenantId: null,
        membershipId: null,
        businessId: null,
        branchId: null,
        typ: "preauth",
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        needsWorkspaceSelection: true,
        workspaces,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tenant: null,
      };
    }

    if (!only) {
      throw new ApiError("NO_MEMBERSHIP", "This user has no tenant membership.", 403);
    }
    const selected = await this.defaultSelectedScope(only);
    return this.issueWorkspaceSession({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: only.organizationId,
      businessId: selected.businessId,
      branchId: selected.branchId,
      membershipId: only.membershipId,
      role: only.role,
      meta,
    });
  }

  async selectContext(userId: string, sessionId: string, raw: unknown, meta: AuthMeta): Promise<AuthPayload> {
    const payload = selectContextRequestSchema.parse(raw);
    const membership = await this.tenants.findMembership(payload.organizationId, userId);
    if (!membership) {
      throw new ApiError("FORBIDDEN", "You cannot switch into that tenant.", 403);
    }
    if (membership.businessId && payload.businessId && payload.businessId !== membership.businessId) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    if (membership.branchId && payload.branchId && payload.branchId !== membership.branchId) {
      throw new ApiError("FORBIDDEN", "Branch is outside your membership scope.", 403);
    }
    const selected = await this.defaultSelectedScope({
      organizationId: membership.tenantId,
      organizationName: "",
      membershipId: membership.id,
      role: membership.role as Role,
      businessId: membership.businessId ?? payload.businessId ?? null,
      businessName: null,
      branchId: membership.branchId ?? payload.branchId ?? null,
      branchName: null,
    });
    const businessId = selected.businessId;
    const branchId = selected.branchId;
    if (businessId) {
      const business = await this.tenants.findBusiness(membership.tenantId, businessId);
      if (!business) {
        throw new ApiError("FORBIDDEN", "Business is outside the authenticated tenant.", 403);
      }
    }
    if (branchId) {
      const branch = await this.tenants.findBranch(membership.tenantId, branchId);
      if (!branch) {
        throw new ApiError("FORBIDDEN", "Branch is outside the authenticated tenant.", 403);
      }
      if (businessId && branch.businessId !== businessId) {
        throw new ApiError("FORBIDDEN", "Branch does not belong to the selected business.", 403);
      }
    }
    const user = await this.findUserById(userId);
    if (!user) {
      throw new ApiError("UNAUTHENTICATED", "User was not found.", 401);
    }
    await this.sessions.revoke(sessionId, userId);
    return this.issueWorkspaceSession({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: membership.tenantId,
      businessId,
      branchId,
      membershipId: membership.id,
      role: membership.role,
      meta,
    });
  }

  async refresh(rawToken: string, meta: AuthMeta) {
    const tokens = await this.sessions.refresh(rawToken, meta);
    return tokens;
  }

  async logout(userId: string, sessionId: string) {
    await this.sessions.revoke(sessionId, userId);
  }

  async changePassword(userId: string, raw: unknown) {
    const payload = changePasswordSchema.parse(raw);
    const user = await this.findUserById(userId);
    if (!user || !(await verifyPassword(user.passwordHash, payload.currentPassword))) {
      throw new ApiError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(payload.newPassword), updatedBy: userId })
      .where(eq(users.id, userId));
  }

  async me(userId: string, tenantId: string) {
    const user = await this.findUserById(userId);
    const organization = await this.tenants.findOrganization(tenantId);
    const membership = await this.tenants.findMembership(tenantId, userId);
    return {
      user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
      organization,
      membership,
      workspaces: await this.listWorkspaces(userId),
      onboardingCompleted: Boolean(organization?.onboardingCompletedAt),
    };
  }

  async listWorkspaces(userId: string): Promise<WorkspaceOption[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "ACTIVE")));
    const result: WorkspaceOption[] = [];
    for (const membership of rows) {
      const organization = await this.tenants.findOrganization(membership.tenantId);
      const business = membership.businessId
        ? await this.tenants.findBusiness(membership.tenantId, membership.businessId)
        : null;
      const branch = membership.branchId
        ? await this.tenants.findBranch(membership.tenantId, membership.branchId)
        : null;
      result.push({
        organizationId: membership.tenantId,
        organizationName: organization?.name ?? "Workspace",
        membershipId: membership.id,
        role: membership.role as Role,
        businessId: membership.businessId,
        businessName: business?.name ?? null,
        branchId: membership.branchId,
        branchName: branch?.name ?? null,
      });
    }
    return result;
  }

  private async issueWorkspaceSession(input: {
    userId: string;
    email: string;
    displayName: string;
    tenantId: string;
    businessId: string | null;
    branchId: string | null;
    membershipId: string;
    role: string;
    meta: AuthMeta;
  }): Promise<AuthPayload> {
    const tokens: IssuedTokens = await this.sessions.issue({
      userId: input.userId,
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      businessId: input.businessId,
      branchId: input.branchId,
      typ: "access",
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
    return {
      user: { id: input.userId, email: input.email, displayName: input.displayName },
      needsWorkspaceSelection: false,
      workspaces: await this.listWorkspaces(input.userId),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tenant: {
        tenantId: input.tenantId,
        businessId: input.businessId,
        branchId: input.branchId,
        membershipId: input.membershipId,
        role: input.role,
      },
    };
  }

  private async defaultSelectedScope(workspace: WorkspaceOption) {
    let businessId = workspace.businessId;
    let branchId = workspace.branchId;
    if (!businessId) {
      const items = await this.tenants.listBusinesses(workspace.organizationId);
      if (items.length === 1 && items[0]) {
        businessId = items[0].id;
      }
    }
    if (businessId && !branchId) {
      const branchRows = await this.tenants.listBranches({
        tenantId: workspace.organizationId,
        businessId,
        membershipBusinessId: workspace.businessId,
        membershipBranchId: workspace.branchId,
      });
      if (branchRows.length === 1 && branchRows[0]) {
        branchId = branchRows[0].id;
      }
    }
    return { businessId, branchId };
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
