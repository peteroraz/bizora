import { Inject, Injectable } from "@nestjs/common";
import { addressInputSchema } from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { addresses } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";

function addressValues(payload: ReturnType<typeof addressInputSchema.parse>) {
  return {
    line1: payload.line1,
    line2: payload.line2 ?? null,
    city: payload.city,
    subdivisionCode: payload.subdivisionCode?.trim() ? payload.subdivisionCode.trim() : null,
    postalCode: payload.postalCode?.trim() ? payload.postalCode.trim() : null,
    countryCode: payload.countryCode,
  };
}

@Injectable()
export class AddressService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, raw: unknown) {
    const payload = addressInputSchema.parse(raw);
    const id = newId();
    const [created] = await this.db
      .insert(addresses)
      .values({
        id,
        tenantId: tenant.tenantId,
        ...addressValues(payload),
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      })
      .returning();
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "address.created",
      entityType: "address",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: tenant.businessId,
      branchId: tenant.branchId,
    });
    return created;
  }

  async get(tenant: TenantContext, id: string) {
    const address = await this.find(tenant.tenantId, id);
    if (!address) {
      throw new ApiError("ADDRESS_NOT_FOUND", "Address was not found.", 404);
    }
    return address;
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const existing = await this.find(tenant.tenantId, id);
    if (!existing) {
      throw new ApiError("ADDRESS_NOT_FOUND", "Address was not found.", 404);
    }
    const payload = addressInputSchema.parse(raw);
    const [updated] = await this.db
      .update(addresses)
      .set({ ...addressValues(payload), updatedAt: new Date(), updatedBy: tenant.userId })
      .where(and(eq(addresses.id, id), eq(addresses.tenantId, tenant.tenantId)))
      .returning();
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "address.updated",
      entityType: "address",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: tenant.businessId,
      branchId: tenant.branchId,
    });
    return updated;
  }

  private async find(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }
}
