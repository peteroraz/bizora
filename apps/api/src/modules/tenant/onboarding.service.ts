import { Inject, Injectable } from "@nestjs/common";
import { completeOnboardingSchema, updateBrandingSchema } from "@bizora/contracts";
import { eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, businesses, organizations } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { TenantRepository } from "./tenant.repository.js";

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
  ) {}

  async complete(tenant: TenantContext, raw: unknown) {
    const payload = completeOnboardingSchema.parse(raw);
    const country = await this.tenants.findCountryPack(payload.countryCode);
    if (!country) {
      throw new ApiError("COUNTRY_PACK_UNKNOWN", "That country pack is not available.", 400);
    }
    const industry = await this.tenants.findIndustryPack(payload.industryCode);
    if (!industry) {
      throw new ApiError("INDUSTRY_PACK_UNKNOWN", "That industry pack is not available.", 400);
    }

    const organization = await this.tenants.findOrganization(tenant.tenantId);
    if (!organization) {
      throw new ApiError("TENANT_NOT_FOUND", "Organization was not found.", 404);
    }

    const businessId = tenant.businessId;
    if (!businessId) {
      throw new ApiError("BUSINESS_REQUIRED", "Select a business before completing onboarding.", 400);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          name: payload.organizationName ?? organization.name,
          primaryColor: payload.primaryColor ?? organization.primaryColor,
          accentColor: payload.accentColor ?? organization.accentColor,
          logoUrl: payload.logoUrl === "" ? null : (payload.logoUrl ?? organization.logoUrl),
          onboardingCompletedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(eq(organizations.id, tenant.tenantId));

      await tx
        .update(businesses)
        .set({
          ...(payload.businessName ? { name: payload.businessName } : {}),
          countryCode: payload.countryCode,
          baseCurrencyCode: payload.baseCurrencyCode,
          timezone: payload.timezone,
          industryCode: payload.industryCode,
          updatedBy: tenant.userId,
        })
        .where(eq(businesses.id, businessId));

      if (payload.branchName && tenant.branchId) {
        await tx
          .update(branches)
          .set({ name: payload.branchName, updatedBy: tenant.userId })
          .where(eq(branches.id, tenant.branchId));
      }
    });

    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "onboarding.completed",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
    });

    return this.tenants.findOrganization(tenant.tenantId);
  }

  async updateBranding(tenant: TenantContext, raw: unknown) {
    const payload = updateBrandingSchema.parse(raw);
    await this.db
      .update(organizations)
      .set({
        ...(payload.primaryColor ? { primaryColor: payload.primaryColor } : {}),
        ...(payload.accentColor ? { accentColor: payload.accentColor } : {}),
        ...(payload.logoUrl !== undefined
          ? { logoUrl: payload.logoUrl === "" || payload.logoUrl === null ? null : payload.logoUrl }
          : {}),
        updatedBy: tenant.userId,
      })
      .where(eq(organizations.id, tenant.tenantId));

    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "branding.updated",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
    });
    return this.tenants.findOrganization(tenant.tenantId);
  }
}
