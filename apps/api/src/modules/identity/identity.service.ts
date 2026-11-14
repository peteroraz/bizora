import { Inject, Injectable } from "@nestjs/common";
import { hashPassword, verifyPassword } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import {
  changePasswordSchema,
  createOrganizationSchema,
  loginRequestSchema,
  registerRequestSchema,
  selectContextRequestSchema,
  type AuthWorkspace,
  type RegisterRequest,
  type Role,
  type WorkspaceOption,
} from "@bizora/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId, slugify } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, businesses, memberships, organizations, sessions, userIdentities, users } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import type { OauthProfile } from "./oauth.service.js";
import { SessionService, type IssuedTokens } from "./session.service.js";

export type AuthMeta = { correlationId: string; ip?: string | null; userAgent?: string | null };

export type AuthPayload = {
  user: { id: string; email: string; displayName: string };
  needsWorkspaceSelection: boolean;
  needsOrganizationSetup: boolean;
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
    @Inject(AccountRecoveryService) private readonly recovery: AccountRecoveryService,
  ) {}

  async register(input: RegisterRequest, meta: AuthMeta): Promise<AuthPayload> {
    const payload = registerRequestSchema.parse(input);
    const existing = await this.findUserByEmail(payload.email);
    if (existing) {
      throw new ApiError("EMAIL_IN_USE", "An account with this email already exists.", 409);
    }

    const defaults = await this.countryDefaults(payload.countryCode);
    const baseCurrencyCode = payload.baseCurrencyCode ?? defaults.baseCurrencyCode;
    const timezone = payload.timezone ?? defaults.timezone;
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
        baseCurrencyCode,
        timezone,
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

    const session = await this.issueWorkspaceSession({
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
    await this.recovery.sendVerification(userId, payload.email.toLowerCase());
    return session;
  }

  private async countryDefaults(code: string) {
    const country = await this.tenants.findCountry(code);
    if (!country) {
      throw new ApiError("COUNTRY_UNKNOWN", "That country is not available.", 400);
    }
    const pack = await this.tenants.findCountryPack(code);
    if (pack) {
      return {
        baseCurrencyCode: pack.defaultCurrencyCode.trim(),
        timezone: pack.defaultTimezone,
      };
    }
    const timezone = country.timezones[0];
    if (!timezone) {
      throw new ApiError("COUNTRY_UNKNOWN", "That country is not available.", 400);
    }
    return {
      baseCurrencyCode: country.defaultCurrencyCode.trim(),
      timezone,
    };
  }

  async login(raw: unknown, meta: AuthMeta): Promise<AuthPayload> {
    const payload = loginRequestSchema.parse(raw);
    const user = await this.findUserByEmail(payload.email);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, payload.password))) {
      throw new ApiError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
    }
    return this.establishSession(user, meta, "password");
  }

  async establishSession(
    user: { id: string; email: string; displayName: string },
    meta: AuthMeta,
    method: "password" | "google",
    allowSetup = false,
  ): Promise<AuthPayload> {
    const workspaces = await this.listWorkspaces(user.id);
    if (workspaces.length === 0) {
      if (!allowSetup) {
        throw new ApiError("NO_MEMBERSHIP", "This user has no tenant membership.", 403);
      }
      await this.auditLogin(user.id, null, meta, method);
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
        needsWorkspaceSelection: false,
        needsOrganizationSetup: true,
        workspaces: [],
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tenant: null,
      };
    }

    const only = workspaces[0];
    await this.auditLogin(user.id, workspaces.length === 1 && only ? only.organizationId : null, meta, method);

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
        needsOrganizationSetup: false,
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
    if (!user) {
      throw new ApiError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
    }
    if (user.passwordHash) {
      if (!payload.currentPassword || !(await verifyPassword(user.passwordHash, payload.currentPassword))) {
        throw new ApiError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
      }
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
      user: user
        ? {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
          }
        : null,
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

  async listAuthWorkspaces(userId: string): Promise<AuthWorkspace[]> {
    const workspaces = await this.listWorkspaces(userId);
    return workspaces
      .map((workspace) => ({
        organizationId: workspace.organizationId,
        organizationName: workspace.organizationName,
        role: workspace.role,
        businessName: workspace.businessName,
        branchName: workspace.branchName,
      }))
      .sort(
        (left, right) =>
          left.organizationName.localeCompare(right.organizationName) || left.role.localeCompare(right.role),
      );
  }

  async createOrganization(userId: string, raw: unknown, meta: AuthMeta): Promise<AuthPayload> {
    const payload = createOrganizationSchema.parse(raw);
    const user = await this.findUserById(userId);
    if (!user) throw new ApiError("UNAUTHENTICATED", "User was not found.", 401);
    const existing = await this.listWorkspaces(userId);
    if (existing.length > 0) {
      throw new ApiError("WORKSPACE_EXISTS", "This account already belongs to a workspace.", 409);
    }
    const defaults = await this.countryDefaults(payload.countryCode);
    const baseCurrencyCode = payload.baseCurrencyCode ?? defaults.baseCurrencyCode;
    const timezone = payload.timezone ?? defaults.timezone;
    const tenantId = newId();
    const businessId = newId();
    const branchId = newId();
    const membershipId = newId();
    const slug = `${slugify(payload.organizationName) || "org"}-${tenantId.slice(0, 8)}`;
    await this.db.transaction(async (tx) => {
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
        baseCurrencyCode,
        timezone,
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
      action: "identity.workspace_created",
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
      email: user.email,
      displayName: user.displayName,
      tenantId,
      businessId,
      branchId,
      membershipId,
      role: "OWNER",
      meta,
    });
  }

  async resolveOauthUser(profile: OauthProfile, meta: AuthMeta) {
    const identity = await this.findIdentity(profile.provider, profile.subject);
    if (identity) {
      await this.db.update(userIdentities).set({ lastUsedAt: new Date(), email: profile.email }).where(eq(userIdentities.id, identity.id));
      const user = await this.findUserById(identity.userId);
      if (!user) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
      return user;
    }
    const existing = await this.findUserByEmail(profile.email);
    if (existing) {
      if (!profile.emailVerified) {
        throw new ApiError("OAUTH_LINK_REQUIRED", "Sign in with your password, then link this provider from Settings.", 409);
      }
      if (!existing.emailVerifiedAt) {
        await this.claimUnverifiedAccount(existing.id, profile, meta);
        const claimed = await this.findUserById(existing.id);
        if (!claimed) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
        return claimed;
      }
      await this.insertIdentity(existing.id, profile);
      await this.auditLink(existing.id, profile, meta);
      return existing;
    }
    if (!profile.emailVerified) {
      throw new ApiError(
        "OAUTH_EMAIL_UNVERIFIED",
        "Your provider didn't confirm this email; register with email and password instead",
        400,
      );
    }
    const userId = newId();
    await this.db.insert(users).values({
      id: userId,
      email: profile.email,
      passwordHash: null,
      displayName: profile.displayName,
      emailVerifiedAt: new Date(),
      createdBy: userId,
      updatedBy: userId,
    });
    await this.insertIdentity(userId, profile);
    await this.auditLink(userId, profile, meta);
    const created = await this.findUserById(userId);
    if (!created) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
    return created;
  }

  async linkIdentity(userId: string, profile: OauthProfile, meta: AuthMeta) {
    if (!profile.emailVerified) {
      throw new ApiError("OAUTH_REJECTED", "That provider did not confirm the email address.", 400);
    }
    const identity = await this.findIdentity(profile.provider, profile.subject);
    if (identity && identity.userId !== userId) {
      throw new ApiError("IDENTITY_IN_USE", "That sign-in method is already used by another account.", 409);
    }
    if (identity) {
      await this.db.update(userIdentities).set({ lastUsedAt: new Date(), email: profile.email }).where(eq(userIdentities.id, identity.id));
      return;
    }
    await this.insertIdentity(userId, profile);
    await this.auditLink(userId, profile, meta);
  }

  async unlinkIdentity(userId: string, provider: string, meta: AuthMeta) {
    if (provider !== "google") {
      throw new ApiError("IDENTITY_NOT_FOUND", "That sign-in method is not linked.", 404);
    }
    const user = await this.findUserById(userId);
    if (!user) throw new ApiError("UNAUTHENTICATED", "User was not found.", 401);
    const identities = await this.db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
    const target = identities.find((item) => item.provider === provider);
    if (!target) throw new ApiError("IDENTITY_NOT_FOUND", "That sign-in method is not linked.", 404);
    const methods = identities.length + (user.passwordHash ? 1 : 0);
    if (methods <= 1) {
      throw new ApiError("LAST_SIGN_IN_METHOD", "Keep at least one way to sign in.", 400);
    }
    await this.db.delete(userIdentities).where(eq(userIdentities.id, target.id));
    await this.audit.record({
      actorUserId: userId,
      action: "identity.unlinked",
      entityType: "user_identity",
      entityId: target.id,
      correlationId: meta.correlationId,
      metadata: { provider },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async security(userId: string, sessionId: string) {
    const user = await this.findUserById(userId);
    if (!user) throw new ApiError("UNAUTHENTICATED", "User was not found.", 401);
    const identities = await this.db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
    const active = await this.sessions.listActive(userId);
    return {
      hasPassword: Boolean(user.passwordHash),
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      identities: identities
        .filter((item) => item.provider === "google")
        .map((item) => ({
          id: item.id,
          provider: item.provider,
          email: item.email,
          lastUsedAt: item.lastUsedAt.toISOString(),
        })),
      sessions: active.map((item) => ({
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        lastUsedAt: item.lastUsedAt.toISOString(),
        userAgent: item.userAgent,
        ip: item.ip,
        current: item.id === sessionId,
      })),
    };
  }

  async revokeOtherSessions(userId: string, sessionId: string) {
    await this.sessions.revokeOthers(userId, sessionId);
    return { ok: true };
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
      needsOrganizationSetup: false,
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

  private async auditLogin(userId: string, tenantId: string | null, meta: AuthMeta, method: string) {
    await this.audit.record({
      tenantId,
      actorUserId: userId,
      action: "identity.login",
      entityType: "user",
      entityId: userId,
      correlationId: meta.correlationId,
      metadata: { method },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private async auditLink(userId: string, profile: OauthProfile, meta: AuthMeta) {
    await this.audit.record({
      actorUserId: userId,
      action: "identity.linked",
      entityType: "user",
      entityId: userId,
      correlationId: meta.correlationId,
      metadata: { provider: profile.provider, subject: profile.subject },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private async claimUnverifiedAccount(userId: string, profile: OauthProfile, meta: AuthMeta) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date(), passwordHash: null, updatedBy: userId })
        .where(eq(users.id, userId));
      await tx.delete(userIdentities).where(eq(userIdentities.userId, userId));
      await tx.insert(userIdentities).values({
        id: newId(),
        userId,
        provider: profile.provider,
        providerSubject: profile.subject,
        email: profile.email,
      });
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await this.audit.record(
        {
          actorUserId: userId,
          action: "identity.takeover_protection",
          entityType: "user",
          entityId: userId,
          correlationId: meta.correlationId,
          metadata: { provider: profile.provider, subject: profile.subject },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  }

  private async findIdentity(provider: string, subject: string) {
    const [row] = await this.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, subject)))
      .limit(1);
    return row ?? null;
  }

  private async insertIdentity(userId: string, profile: OauthProfile) {
    await this.db.insert(userIdentities).values({
      id: newId(),
      userId,
      provider: profile.provider,
      providerSubject: profile.subject,
      email: profile.email,
    });
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
