import { Controller, Get, Header, Inject, Req, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { success } from "@bizora/contracts";
import type { Request } from "express";
import { ReferenceService } from "./reference.service.js";

@Controller("api/v1/public/reference")
@UseGuards(ThrottlerGuard)
export class PublicReferenceController {
  constructor(@Inject(ReferenceService) private readonly reference: ReferenceService) {}

  @Get("countries")
  @Header("Cache-Control", "public, max-age=86400")
  async countries(@Req() req: Request & { correlationId?: string }) {
    return success({ items: await this.reference.listPublicCountries() }, req.correlationId ?? "reference");
  }
}
