import { Inject, Injectable } from "@nestjs/common";
import {
  completeOnboardingSchema,
  updateBrandingSchema,
  updateBranchSchema,
  updateBusinessSchema,
  updateOrganizationSchema,
} from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import {
  canManageBranchSettings,
  canManageBusinessSettings,
  canManageOrganizationSettings,
} from "../../common/tenant-scope.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { addresses, branches, businesses, organizations } from "../../db/schema.js";
import { DB, FINANCIAL_LEDGER } from "../../tokens.js";
import { AddressService } from "../addresses/address.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { FinancialLedgerPort } from "./financial-ledger.port.js";
import { TenantRepository } from "./tenant.repository.js";

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
    @Inject(FINANCIAL_LEDGER) private readonly ledger: FinancialLedgerPort,
    @Inject(AddressService) private readonly addressesService: AddressService,
  ) {}

  async complete(tenant: TenantContext, raw: unknown) {
    const payload = completeOnboardingSchema.parse(raw);
    const country = await this.tenants.findCountry(payload.countryCode);
    if (!country) {
      throw new ApiError("COUNTRY_UNKNOWN", "That country is not available.", 400);
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
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }

    const countryChanged = business.countryCode !== payload.countryCode;
    const currencyChanged = business.baseCurrencyCode !== payload.baseCurrencyCode;
    if (countryChanged || currencyChanged) {
      if (!canManageBusinessSettings(tenant, businessId)) {
        throw new ApiError("FORBIDDEN", "Business country and currency require business or organization authority.", 403);
      }
      if (currencyChanged && (await this.ledger.hasPostedTransactions(tenant.tenantId, businessId))) {
        throw new ApiError("CURRENCY_LOCKED", "Base currency cannot change after financial transactions exist.", 409);
      }
    }

    if (payload.organizationName && !canManageOrganizationSettings(tenant)) {
      throw new ApiError("FORBIDDEN", "Organization settings require organization-wide authority.", 403);
    }

    const phone = payload.phoneE164 ? payload.phoneE164 : payload.phoneE164 === undefined ? undefined : null;
    let createdAddressId: string | null = null;

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
        .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)));

      if (payload.branchName && tenant.branchId) {
        await tx
          .update(branches)
          .set({ name: payload.branchName, updatedBy: tenant.userId })
          .where(and(eq(branches.id, tenant.branchId), eq(branches.tenantId, tenant.tenantId)));
      }

      if (payload.address) {
        createdAddressId = newId();
        await tx.insert(addresses).values({
          id: createdAddressId,
          tenantId: tenant.tenantId,
          line1: payload.address.line1,
          line2: payload.address.line2 ?? null,
          city: payload.address.city,
          subdivisionCode: payload.address.subdivisionCode ?? null,
          postalCode: payload.address.postalCode ?? null,
          countryCode: payload.address.countryCode,
          createdBy: tenant.userId,
          updatedBy: tenant.userId,
        });
      }

      if (createdAddressId || phone !== undefined) {
        await tx
          .update(businesses)
          .set({
            ...(createdAddressId ? { addressId: createdAddressId } : {}),
            ...(phone !== undefined ? { phoneE164: phone } : {}),
            updatedBy: tenant.userId,
          })
          .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)));
        if (tenant.branchId) {
          await tx
            .update(branches)
            .set({
              ...(createdAddressId ? { addressId: createdAddressId } : {}),
              ...(phone !== undefined ? { phoneE164: phone } : {}),
              updatedBy: tenant.userId,
            })
            .where(and(eq(branches.id, tenant.branchId), eq(branches.tenantId, tenant.tenantId)));
        }
        if (canManageOrganizationSettings(tenant)) {
          await tx
            .update(organizations)
            .set({
              ...(createdAddressId ? { addressId: createdAddressId } : {}),
              ...(phone !== undefined ? { phoneE164: phone } : {}),
              updatedBy: tenant.userId,
            })
            .where(eq(organizations.id, tenant.tenantId));
        }
      }
    });

    if (createdAddressId) {
      await this.audit.record({
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "address.created",
        entityType: "address",
        entityId: createdAddressId,
        correlationId: tenant.correlationId,
        businessId,
        branchId: tenant.branchId,
      });
    }

    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "onboarding.completed",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
      businessId,
      branchId: tenant.branchId,
    });

    return this.tenants.findOrganization(tenant.tenantId);
  }

  async updateBranding(tenant: TenantContext, raw: unknown) {
    if (!canManageOrganizationSettings(tenant)) {
      throw new ApiError("FORBIDDEN", "Organization settings require organization-wide authority.", 403);
    }
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

  async updateBusiness(tenant: TenantContext, businessId: string, raw: unknown) {
    const payload = updateBusinessSchema.parse(raw);
    if (!canManageBusinessSettings(tenant, businessId)) {
      throw new ApiError("FORBIDDEN", "You cannot change business-level configuration.", 403);
    }
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    const currencyChanged =
      payload.baseCurrencyCode !== undefined && payload.baseCurrencyCode !== business.baseCurrencyCode;
    if (currencyChanged && (await this.ledger.hasPostedTransactions(tenant.tenantId, businessId))) {
      throw new ApiError("CURRENCY_LOCKED", "Base currency cannot change after financial transactions exist.", 409);
    }
    if (payload.countryCode) {
      const country = await this.tenants.findCountry(payload.countryCode);
      if (!country) {
        throw new ApiError("COUNTRY_UNKNOWN", "That country is not available.", 400);
      }
    }
    const [updated] = await this.db
      .update(businesses)
      .set({
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.countryCode ? { countryCode: payload.countryCode } : {}),
        ...(payload.baseCurrencyCode ? { baseCurrencyCode: payload.baseCurrencyCode } : {}),
        ...(payload.timezone ? { timezone: payload.timezone } : {}),
        ...(payload.industryCode !== undefined ? { industryCode: payload.industryCode } : {}),
        ...(payload.phoneE164 !== undefined ? { phoneE164: payload.phoneE164 || null } : {}),
        updatedBy: tenant.userId,
      })
      .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)))
      .returning();
    if (!updated) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    return updated;
  }

  async updateBranch(tenant: TenantContext, branchId: string, raw: unknown) {
    const payload = updateBranchSchema.parse(raw);
    const branch = await this.tenants.findBranch(tenant.tenantId, branchId);
    if (!branch) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    if (!canManageBranchSettings(tenant, branch)) {
      throw new ApiError("FORBIDDEN", "You cannot change this branch.", 403);
    }
    const [updated] = await this.db
      .update(branches)
      .set({
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.phoneE164 !== undefined ? { phoneE164: payload.phoneE164 || null } : {}),
        updatedBy: tenant.userId,
      })
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenant.tenantId)))
      .returning();
    if (!updated) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    return updated;
  }

  async updateOrganization(tenant: TenantContext, raw: unknown) {
    if (!canManageOrganizationSettings(tenant)) {
      throw new ApiError("FORBIDDEN", "Organization settings require organization-wide authority.", 403);
    }
    const payload = updateOrganizationSchema.parse(raw);
    await this.db
      .update(organizations)
      .set({
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.phoneE164 !== undefined ? { phoneE164: payload.phoneE164 || null } : {}),
        updatedBy: tenant.userId,
      })
      .where(eq(organizations.id, tenant.tenantId));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "organization.updated",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
    });
    return this.tenants.findOrganization(tenant.tenantId);
  }

  async upsertOrganizationAddress(tenant: TenantContext, raw: unknown) {
    if (!canManageOrganizationSettings(tenant)) {
      throw new ApiError("FORBIDDEN", "Organization settings require organization-wide authority.", 403);
    }
    const organization = await this.tenants.findOrganization(tenant.tenantId);
    if (!organization) {
      throw new ApiError("ORGANIZATION_NOT_FOUND", "Organization was not found.", 404);
    }
    const address = await this.addressesService.upsert(tenant, organization.addressId, raw);
    if (organization.addressId !== address.id) {
      await this.db
        .update(organizations)
        .set({ addressId: address.id, updatedBy: tenant.userId })
        .where(eq(organizations.id, tenant.tenantId));
    }
    return address;
  }

  async upsertBusinessAddress(tenant: TenantContext, businessId: string, raw: unknown) {
    if (!canManageBusinessSettings(tenant, businessId)) {
      throw new ApiError("FORBIDDEN", "You cannot change business-level configuration.", 403);
    }
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    const address = await this.addressesService.upsert(tenant, business.addressId, raw);
    if (business.addressId !== address.id) {
      await this.db
        .update(businesses)
        .set({ addressId: address.id, updatedBy: tenant.userId })
        .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)));
    }
    return address;
  }

  async upsertBranchAddress(tenant: TenantContext, branchId: string, raw: unknown) {
    const branch = await this.tenants.findBranch(tenant.tenantId, branchId);
    if (!branch) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    if (!canManageBranchSettings(tenant, branch)) {
      throw new ApiError("FORBIDDEN", "You cannot change this branch.", 403);
    }
    const address = await this.addressesService.upsert(tenant, branch.addressId, raw);
    if (branch.addressId !== address.id) {
      await this.db
        .update(branches)
        .set({ addressId: address.id, updatedBy: tenant.userId })
        .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenant.tenantId)));
    }
    return address;
  }
}
