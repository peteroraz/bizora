import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Permission, createBranchSchema, success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { branches } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import type { AppDatabase } from "../../db/database.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { OnboardingService } from "./onboarding.service.js";
import { TenantGuard } from "./tenant.guard.js";
import { TenantRepository } from "./tenant.repository.js";

@Controller("api/v1")
export class TenantController {
  constructor(
    @Inject(TenantRepository) private readonly tenants: TenantRepository,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(DB) private readonly db: AppDatabase,
  ) {}

  @Get("catalogs/country-packs")
  async countryPacks() {
    return success({ items: await this.tenants.listCountryPacks() }, "catalog");
  }

  @Get("catalogs/industry-packs")
  async industryPacks() {
    return success({ items: await this.tenants.listIndustryPacks() }, "catalog");
  }

  @Get("organizations/current")
  @UseGuards(TenantGuard)
  async currentOrganization(@CurrentTenant() tenant: TenantContext) {
    const organization = await this.tenants.findOrganization(tenant.tenantId);
    return success({ organization, tenant }, tenant.correlationId);
  }

  @Patch("onboarding")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.ONBOARDING_COMPLETE)
  async completeOnboarding(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const organization = await this.onboarding.complete(tenant, body);
    return success({ organization }, tenant.correlationId);
  }

  @Patch("organizations/current/branding")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async updateBranding(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const organization = await this.onboarding.updateBranding(tenant, body);
    return success({ organization }, tenant.correlationId);
  }

  @Get("businesses")
  @UseGuards(TenantGuard)
  async listBusinesses(@CurrentTenant() tenant: TenantContext) {
    const items = await this.tenants.listBusinesses(tenant.tenantId, tenant.membershipBusinessId);
    return success({ items }, tenant.correlationId);
  }

  @Get("businesses/:id")
  @UseGuards(TenantGuard)
  async getBusiness(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    if (tenant.membershipBusinessId && tenant.membershipBusinessId !== id) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    const business = await this.tenants.findBusiness(tenant.tenantId, id);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    return success({ business }, tenant.correlationId);
  }

  @Get("branches")
  @UseGuards(TenantGuard)
  async listBranches(@CurrentTenant() tenant: TenantContext) {
    const items = await this.tenants.listBranches(tenant);
    return success({ items }, tenant.correlationId);
  }

  @Get("branches/:id")
  @UseGuards(TenantGuard)
  async getBranch(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const branch = await this.tenants.findVisibleBranch(tenant, id);
    if (!branch) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    return success({ branch }, tenant.correlationId);
  }

  @Post("branches")
  @UseGuards(TenantGuard, PermissionGuard)
  @RequirePermissions(Permission.BRANCHES_MANAGE)
  async createBranch(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const payload = createBranchSchema.parse(body);
    const businessId = payload.businessId ?? tenant.businessId;
    if (!businessId) {
      throw new ApiError("BUSINESS_REQUIRED", "A business is required to create a branch.", 400);
    }
    if (tenant.membershipBusinessId && tenant.membershipBusinessId !== businessId) {
      throw new ApiError("FORBIDDEN", "Business is outside your membership scope.", 403);
    }
    const business = await this.tenants.findBusiness(tenant.tenantId, businessId);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    const id = newId();
    await this.db.insert(branches).values({
      id,
      tenantId: tenant.tenantId,
      businessId,
      name: payload.name,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    });
    const branch = await this.tenants.findBranch(tenant.tenantId, id);
    return success({ branch }, tenant.correlationId);
  }
}
