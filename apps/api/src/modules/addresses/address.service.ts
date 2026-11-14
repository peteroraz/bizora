import { Inject, Injectable } from "@nestjs/common";
import { addressInputSchema } from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";

type AddressStore = Pick<AppDatabase, "insert" | "update" | "select">;
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

  /**
   * Creates or updates the address row already linked to an owner.
   * Callers resolve `existingId` from that owner and enforce their own permission.
   * A client never supplies the address id.
   */
  async upsert(tenant: TenantContext, existingId: string | null, raw: unknown, store: AddressStore = this.db) {
    const values = addressValues(addressInputSchema.parse(raw));
    if (existingId) {
      const existing = await this.find(tenant.tenantId, existingId, store);
      if (!existing) {
        throw new ApiError("ADDRESS_NOT_FOUND", "Address was not found.", 404);
      }
      const [updated] = await store
        .update(addresses)
        .set({ ...values, updatedAt: new Date(), updatedBy: tenant.userId })
        .where(and(eq(addresses.id, existingId), eq(addresses.tenantId, tenant.tenantId)))
        .returning();
      if (!updated) {
        throw new ApiError("ADDRESS_NOT_FOUND", "Address was not found.", 404);
      }
      await this.record(tenant, existingId, "address.updated", store);
      return updated;
    }

    const id = newId();
    const [created] = await store
      .insert(addresses)
      .values({
        id,
        tenantId: tenant.tenantId,
        ...values,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      })
      .returning();
    if (!created) {
      throw new ApiError("ADDRESS_NOT_FOUND", "Address was not found.", 404);
    }
    await this.record(tenant, id, "address.created", store);
    return created;
  }

  private async record(
    tenant: TenantContext,
    id: string,
    action: "address.created" | "address.updated",
    store: Pick<AppDatabase, "insert">,
  ) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "address",
        entityId: id,
        correlationId: tenant.correlationId,
        businessId: tenant.businessId,
        branchId: tenant.branchId,
      },
      store,
    );
  }

  private async find(tenantId: string, id: string, store: AddressStore) {
    const [row] = await store
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }
}
