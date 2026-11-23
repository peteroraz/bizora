import { Inject, Injectable } from "@nestjs/common";
import {
  addressInputSchema,
  businessTypeFromIndustry,
  completeOnboardingSchema,
  deriveTraderSetup,
  industryForBusinessType,
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
    const industryCode = payload.industryCode ?? (payload.businessType ? industryForBusinessType(payload.businessType) : null);
    if (!industryCode) {
      throw new ApiError("INDUSTRY_PACK_UNKNOWN", "That industry pack is not available.", 400);
    }
    const industry = await this.tenants.findIndustryPack(industryCode);
    if (!industry) {
      throw new ApiError("INDUSTRY_PACK_UNKNOWN", "That industry pack is not available.", 400);
    }
    const traderAnswers =
      payload.businessType !== undefined ||
      payload.staffCountBand !== undefined ||
      payload.otherCurrencies !== undefined ||
      payload.marketOrPlaza !== undefined ||
      payload.tradeCity !== undefined;
    const setup = traderAnswers
      ? deriveTraderSetup({
          businessType: payload.businessType ?? businessTypeFromIndustry(industryCode),
          staffCountBand: payload.staffCountBand ?? null,
          otherCurrencies: payload.otherCurrencies ?? false,
        })
      : null;
    const place = payload.address || payload.tradeCity
      ? {
          line1: payload.address?.line1 || payload.marketOrPlaza || payload.tradeCity || "",
          line2: payload.address?.line2 ?? null,
          city: payload.address?.city || payload.tradeCity || "",
          subdivisionCode: payload.address?.subdivisionCode ?? payload.tradeSubdivisionCode ?? null,
          postalCode: payload.address?.postalCode ?? null,
          countryCode: payload.address?.countryCode || payload.countryCode,
          marketOrPlaza: payload.address?.marketOrPlaza ?? payload.marketOrPlaza ?? null,
          lineOrBlock: payload.address?.lineOrBlock ?? null,
          shopNumber: payload.address?.shopNumber ?? null,
        }
      : null;
    const parsedPlace = place ? addressInputSchema.parse(place) : null;

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
          onboardingCompletedAt: new Date(),
          ...(traderAnswers
            ? {
                traderProfile: {
                  businessType: payload.businessType ?? businessTypeFromIndustry(industryCode),
                  marketOrPlaza: payload.marketOrPlaza ?? null,
                  tradeCity: payload.tradeCity ?? null,
                  tradeSubdivisionCode: payload.tradeSubdivisionCode ?? null,
                  otherCurrencies: payload.otherCurrencies ?? false,
                  staffCountBand: payload.staffCountBand ?? null,
                  branchCount: payload.branchCount ?? null,
                  whatYouSell: payload.whatYouSell || null,
                },
              }
            : {}),
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
          industryCode,
          ...(payload.businessType ? { businessType: payload.businessType } : {}),
          ...(payload.otherCurrencies !== undefined ? { otherCurrencies: payload.otherCurrencies } : {}),
          ...(payload.staffCountBand ? { staffCountBand: payload.staffCountBand } : {}),
          ...(payload.branchCount !== undefined ? { branchCount: payload.branchCount } : {}),
          ...(payload.whatYouSell !== undefined ? { whatYouSell: payload.whatYouSell || null } : {}),
          ...(setup
            ? {
                multiCurrencyEnabled: setup.multiCurrency,
                staffFeaturesEnabled: setup.staffFeatures,
                visibleModules: setup.modules,
              }
            : {}),
          updatedBy: tenant.userId,
        })
        .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)));

      if (payload.branchName && tenant.branchId) {
        await tx
          .update(branches)
          .set({ name: payload.branchName, updatedBy: tenant.userId })
          .where(and(eq(branches.id, tenant.branchId), eq(branches.tenantId, tenant.tenantId)));
      }

      if (parsedPlace) {
        createdAddressId = newId();
        const marketOrPlaza = parsedPlace.marketOrPlaza?.trim() ? parsedPlace.marketOrPlaza.trim() : null;
        const lineOrBlock = parsedPlace.lineOrBlock?.trim() ? parsedPlace.lineOrBlock.trim() : null;
        const shopNumber = parsedPlace.shopNumber?.trim() ? parsedPlace.shopNumber.trim() : null;
        await tx.insert(addresses).values({
          id: createdAddressId,
          tenantId: tenant.tenantId,
          line1: parsedPlace.line1?.trim() || marketOrPlaza || shopNumber || parsedPlace.city,
          line2: parsedPlace.line2 ?? null,
          city: parsedPlace.city,
          subdivisionCode: parsedPlace.subdivisionCode?.trim() ? parsedPlace.subdivisionCode.trim() : null,
          postalCode: parsedPlace.postalCode?.trim() ? parsedPlace.postalCode.trim() : null,
          countryCode: parsedPlace.countryCode,
          marketOrPlaza,
          lineOrBlock,
          shopNumber,
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
    const touchesTrader =
      payload.businessType !== undefined ||
      payload.otherCurrencies !== undefined ||
      payload.staffCountBand !== undefined ||
      payload.branchCount !== undefined ||
      payload.whatYouSell !== undefined ||
      payload.multiCurrencyEnabled !== undefined ||
      payload.staffFeaturesEnabled !== undefined ||
      payload.visibleModules !== undefined;
    const setup = touchesTrader
      ? deriveTraderSetup({
          businessType: payload.businessType ?? business.businessType,
          staffCountBand: payload.staffCountBand ?? business.staffCountBand,
          otherCurrencies: payload.otherCurrencies ?? business.otherCurrencies,
          staffFeaturesEnabled: payload.staffFeaturesEnabled,
          multiCurrencyEnabled: payload.multiCurrencyEnabled,
          visibleModules: payload.visibleModules,
        })
      : null;
    const [updated] = await this.db
      .update(businesses)
      .set({
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.countryCode ? { countryCode: payload.countryCode } : {}),
        ...(payload.baseCurrencyCode ? { baseCurrencyCode: payload.baseCurrencyCode } : {}),
        ...(payload.timezone ? { timezone: payload.timezone } : {}),
        ...(payload.industryCode !== undefined
          ? { industryCode: payload.industryCode }
          : payload.businessType
            ? { industryCode: industryForBusinessType(payload.businessType) }
            : {}),
        ...(payload.phoneE164 !== undefined ? { phoneE164: payload.phoneE164 || null } : {}),
        ...(payload.salesFlow ? { salesFlow: payload.salesFlow } : {}),
        ...(payload.salesItems ? { salesItems: payload.salesItems } : {}),
        ...(payload.rememberItems !== undefined ? { rememberItems: payload.rememberItems } : {}),
        ...(payload.quickCatalog !== undefined ? { quickCatalog: payload.quickCatalog } : {}),
        ...(setup
          ? {
              businessType: payload.businessType ?? business.businessType,
              otherCurrencies: payload.otherCurrencies ?? business.otherCurrencies,
              staffCountBand: payload.staffCountBand ?? business.staffCountBand,
              branchCount: payload.branchCount !== undefined ? payload.branchCount : business.branchCount,
              whatYouSell: payload.whatYouSell !== undefined ? payload.whatYouSell || null : business.whatYouSell,
              multiCurrencyEnabled: payload.multiCurrencyEnabled ?? setup.multiCurrency,
              staffFeaturesEnabled: payload.staffFeaturesEnabled ?? setup.staffFeatures,
              visibleModules: setup.modules,
            }
          : {}),
        updatedBy: tenant.userId,
      })
      .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)))
      .returning();
    if (!updated) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    if (setup && canManageOrganizationSettings(tenant)) {
      await this.db
        .update(organizations)
        .set({
          traderProfile: {
            businessType: updated.businessType,
            otherCurrencies: updated.otherCurrencies,
            staffCountBand: updated.staffCountBand,
            branchCount: updated.branchCount,
            whatYouSell: updated.whatYouSell,
            multiCurrencyEnabled: updated.multiCurrencyEnabled,
            staffFeaturesEnabled: updated.staffFeaturesEnabled,
            visibleModules: updated.visibleModules,
          },
          updatedBy: tenant.userId,
        })
        .where(eq(organizations.id, tenant.tenantId));
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
        ...(payload.kind ? { kind: payload.kind } : {}),
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
    return this.db.transaction(async (tx) => {
      const address = await this.addressesService.upsert(tenant, organization.addressId, raw, tx);
      if (organization.addressId !== address.id) {
        await tx
          .update(organizations)
          .set({ addressId: address.id, updatedBy: tenant.userId })
          .where(eq(organizations.id, tenant.tenantId));
      }
      return address;
    });
  }

  async upsertBusinessAddress(tenant: TenantContext, businessId: string, raw: unknown) {
    if (!canManageBusinessSettings(tenant, businessId)) {
      throw new ApiError("FORBIDDEN", "You cannot change business-level configuration.", 403);
    }
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    return this.db.transaction(async (tx) => {
      const address = await this.addressesService.upsert(tenant, business.addressId, raw, tx);
      if (business.addressId !== address.id) {
        await tx
          .update(businesses)
          .set({ addressId: address.id, updatedBy: tenant.userId })
          .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenant.tenantId)));
      }
      return address;
    });
  }

  async upsertBranchAddress(tenant: TenantContext, branchId: string, raw: unknown) {
    const branch = await this.tenants.findBranch(tenant.tenantId, branchId);
    if (!branch) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    if (!canManageBranchSettings(tenant, branch)) {
      throw new ApiError("FORBIDDEN", "You cannot change this branch.", 403);
    }
    return this.db.transaction(async (tx) => {
      const address = await this.addressesService.upsert(tenant, branch.addressId, raw, tx);
      if (branch.addressId !== address.id) {
        await tx
          .update(branches)
          .set({ addressId: address.id, updatedBy: tenant.userId })
          .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenant.tenantId)));
      }
      return address;
    });
  }
}
