import { Controller, Get, Header, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { success } from "@bizora/contracts";
import type { Request } from "express";
import { SessionGuard } from "../identity/session.guard.js";
import { ReferenceService } from "./reference.service.js";

@Controller("api/v1/reference")
@UseGuards(SessionGuard)
export class ReferenceController {
  constructor(@Inject(ReferenceService) private readonly reference: ReferenceService) {}

  @Get("countries")
  @Header("Cache-Control", "private, max-age=86400")
  async countries(@Req() req: Request & { correlationId?: string }) {
    return success({ items: await this.reference.listCountries() }, req.correlationId ?? "reference");
  }

  @Get("countries/:code/subdivisions")
  @Header("Cache-Control", "private, max-age=86400")
  async subdivisions(@Param("code") code: string, @Req() req: Request & { correlationId?: string }) {
    return success({ items: await this.reference.listSubdivisions(code) }, req.correlationId ?? "reference");
  }
}
