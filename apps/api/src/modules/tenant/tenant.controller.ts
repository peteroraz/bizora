import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { TenantGuard } from "./tenant.guard.js";
import { TenantRepository } from "./tenant.repository.js";

@Controller("api/v1")
@UseGuards(TenantGuard)
export class TenantController {
  constructor(private readonly tenants: TenantRepository) {}

  @Get("organizations/current")
  async currentOrganization(@CurrentTenant() tenant: TenantContext) {
    const organization = await this.tenants.findOrganization(tenant.tenantId);
    return success({ organization, tenant }, tenant.correlationId);
  }

  @Get("businesses")
  async listBusinesses(@CurrentTenant() tenant: TenantContext) {
    const items = await this.tenants.listBusinesses(tenant.tenantId);
    return success({ items }, tenant.correlationId);
  }

  @Get("businesses/:id")
  async getBusiness(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const business = await this.tenants.findBusiness(tenant.tenantId, id);
    if (!business) {
      throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
    }
    return success({ business }, tenant.correlationId);
  }

  @Get("branches")
  async listBranches(@CurrentTenant() tenant: TenantContext) {
    const items = await this.tenants.listBranches(tenant.tenantId, tenant.businessId ?? undefined);
    return success({ items }, tenant.correlationId);
  }

  @Get("branches/:id")
  async getBranch(@CurrentTenant() tenant: TenantContext, @Param("id") id: string) {
    const branch = await this.tenants.findBranch(tenant.tenantId, id);
    if (!branch) {
      throw new ApiError("BRANCH_NOT_FOUND", "Branch was not found.", 404);
    }
    return success({ branch }, tenant.correlationId);
  }
}
