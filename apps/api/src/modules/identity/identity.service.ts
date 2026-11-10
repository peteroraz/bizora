import { Inject, Injectable } from "@nestjs/common";
import { hashPassword, signAccessToken, verifyPassword } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import {
  loginRequestSchema,
  registerRequestSchema,
  selectContextRequestSchema,
  type RegisterRequest,
} from "@bizora/contracts";
import { eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId, slugify } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, businesses, memberships, organizations, users } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "../tenant/tenant.repository.js";

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly audit: AuditService,
    private readonly tenants: TenantRepository,
  ) {}

  async register(input: RegisterRequest, correlationId: string) {
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
        businessId,
        branchId,
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
      correlationId,
    });

    return this.issueSession({
      userId,
      email: payload.email.toLowerCase(),
      displayName: payload.displayName,
      tenantId,
      businessId,
      branchId,
      membershipId,
      role: "OWNER",
    });
  }

  async login(raw: unknown, correlationId: string) {
    const payload = loginRequestSchema.parse(raw);
    const user = await this.findUserByEmail(payload.email);
    if (!user || !(await verifyPassword(user.passwordHash, payload.password))) {
      throw new ApiError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
    }

    const [membership] = await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .limit(1);
    if (!membership) {
      throw new ApiError("NO_MEMBERSHIP", "This user has no tenant membership.", 403);
    }

    await this.audit.record({
      tenantId: membership.tenantId,
      actorUserId: user.id,
      action: "identity.login",
      entityType: "user",
      entityId: user.id,
      correlationId,
    });

    return this.issueSession({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: membership.tenantId,
      businessId: membership.businessId,
      branchId: membership.branchId,
      membershipId: membership.id,
      role: membership.role,
    });
  }

  async selectContext(userId: string, raw: unknown) {
    const payload = selectContextRequestSchema.parse(raw);
    const membership = await this.tenants.findMembership(payload.organizationId, userId);
    if (!membership) {
      throw new ApiError("FORBIDDEN", "You cannot switch into that tenant.", 403);
    }
    let businessId = payload.businessId ?? membership.businessId;
    let branchId = payload.branchId ?? membership.branchId;
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
    }
    const user = await this.findUserById(userId);
    if (!user) {
      throw new ApiError("UNAUTHENTICATED", "User was not found.", 401);
    }
    return this.issueSession({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: membership.tenantId,
      businessId,
      branchId,
      membershipId: membership.id,
      role: membership.role,
    });
  }

  async me(userId: string, tenantId: string) {
    const user = await this.findUserById(userId);
    const organization = await this.tenants.findOrganization(tenantId);
    const membership = await this.tenants.findMembership(tenantId, userId);
    return { user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null, organization, membership };
  }

  private async findUserByEmail(email: string) {
    const [row] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return row ?? null;
  }

  private async findUserById(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  private async issueSession(input: {
    userId: string;
    email: string;
    displayName: string;
    tenantId: string;
    businessId: string | null;
    branchId: string | null;
    membershipId: string;
    role: string;
  }) {
    const accessToken = await signAccessToken(
      {
        sub: input.userId,
        org: input.tenantId,
        bid: input.businessId,
        br: input.branchId,
        mid: input.membershipId,
        role: input.role as "OWNER",
      },
      this.env.JWT_SECRET,
      this.env.JWT_ACCESS_TTL,
    );
    return {
      accessToken,
      user: { id: input.userId, email: input.email, displayName: input.displayName },
      tenant: {
        tenantId: input.tenantId,
        businessId: input.businessId,
        branchId: input.branchId,
        membershipId: input.membershipId,
        role: input.role,
      },
    };
  }
}
