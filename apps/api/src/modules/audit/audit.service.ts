import { Inject, Injectable } from "@nestjs/common";
import type { ActorType } from "@bizora/contracts";
import { auditEvents } from "../../db/schema.js";
import { newId } from "../../common/ids.js";
import { DB } from "../../tokens.js";
import type { AppDatabase } from "../../db/database.js";

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async record(input: {
    tenantId?: string | null;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    correlationId: string;
    metadata?: Record<string, unknown>;
    businessId?: string | null;
    branchId?: string | null;
    actorType?: ActorType;
    source?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    await this.db.insert(auditEvents).values({
      id: newId(),
      tenantId: input.tenantId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      correlationId: input.correlationId,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      businessId: input.businessId ?? null,
      branchId: input.branchId ?? null,
      actorType: input.actorType ?? "HUMAN",
      source: input.source ?? "API",
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  }
}
