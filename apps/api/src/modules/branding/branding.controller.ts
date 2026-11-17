import { Body, Controller, Delete, Get, Header, Inject, Param, Patch, Put, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { Permission, success } from "@bizora/contracts";
import type { Response } from "express";
import { ApiError } from "../../common/errors.js";
import { CurrentTenant, type TenantContext } from "../../common/tenant-context.js";
import { PermissionGuard } from "../rbac/permission.guard.js";
import { RequirePermissions } from "../rbac/permissions.js";
import { TenantGuard } from "../tenant/tenant.guard.js";
import { BrandingService } from "./branding.service.js";

@Controller("api/v1/organizations/current")
@UseGuards(TenantGuard, PermissionGuard)
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  /** Everyone in the company may see the branding (the app shows the logo). */
  @Get("branding")
  async view(@CurrentTenant() tenant: TenantContext) {
    return success({ branding: await this.branding.view(tenant) }, tenant.correlationId);
  }

  @Patch("branding")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async update(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ branding: await this.branding.update(tenant, body) }, tenant.correlationId);
  }

  /** The business's link name and one line about it (6e). */
  @Patch("profile")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async profile(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ branding: await this.branding.updateProfile(tenant, body) }, tenant.correlationId);
  }

  @Get("handle-check")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async handleCheck(@CurrentTenant() tenant: TenantContext, @Query("handle") handle?: string) {
    return success(await this.branding.handleAvailable(tenant, handle ?? ""), tenant.correlationId);
  }

  @Put("logo")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async upload(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    return success({ branding: await this.branding.uploadLogo(tenant, body) }, tenant.correlationId);
  }

  @Delete("logo")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async remove(@CurrentTenant() tenant: TenantContext) {
    return success({ branding: await this.branding.removeLogo(tenant) }, tenant.correlationId);
  }

  /** The logo picture. Private to signed-in staff; the ?v= version in the address changes when the logo does. */
  @Get("logo")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'")
  async logo(@CurrentTenant() tenant: TenantContext, @Res({ passthrough: true }) response: Response) {
    const logo = await this.branding.logo(tenant);
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.setHeader("ETag", logo.etag);
    return new StreamableFile(logo.data, { type: logo.contentType, disposition: "inline", length: logo.data.length });
  }

  @Get("branding/sample")
  @RequirePermissions(Permission.BRANDING_MANAGE)
  async sample(@CurrentTenant() tenant: TenantContext, @Query("type") type?: string) {
    if (type !== undefined && type !== "receipt" && type !== "invoice") throw new ApiError("NOT_FOUND", "Sample not found.", 404);
    const { fileName, pdf } = await this.branding.sample(tenant, type ?? "receipt");
    return new StreamableFile(pdf, { type: "application/pdf", disposition: `inline; filename="${fileName}"`, length: pdf.length });
  }
}

/** A business's public page, by its link name. No sign-in; nothing about sales, customers or money. */
@Controller("api/v1/public/profiles")
export class PublicProfileController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Get(":handle")
  @Header("Cache-Control", "public, max-age=300")
  async profile(@Param("handle") handle: string) {
    return success({ profile: await this.branding.publicProfile(handle) }, "public");
  }

  @Get(":handle/logo")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'")
  @Header("Cache-Control", "public, max-age=3600")
  async logo(@Param("handle") handle: string) {
    const logo = await this.branding.publicLogo(handle);
    return new StreamableFile(logo.data, { type: logo.contentType, disposition: "inline", length: logo.data.length });
  }
}
