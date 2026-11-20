import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { adminAudit } from "../../db/schema.js";
import { DB } from "../../tokens.js";

/** Everything Bizora staff do in the Admin portal, including what they looked at (ADR-037). Never edited. */
@Injectable()
export class AdminAuditService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async record(input: {
    staffId: string | null;
    staffEmail: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    tenantId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  }) {
    await this.db.insert(adminAudit).values({
      id: newId(),
      staffId: input.staffId,
      staffEmail: input.staffEmail,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      tenantId: input.tenantId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    });
  }

  async list(filter: { tenantId?: string; staffId?: string; before?: Date; limit?: number }) {
    const where: SQL[] = [];
    if (filter.tenantId) where.push(eq(adminAudit.tenantId, filter.tenantId));
    if (filter.staffId) where.push(eq(adminAudit.staffId, filter.staffId));
    if (filter.before) where.push(lt(adminAudit.createdAt, filter.before));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.db
      .select()
      .from(adminAudit)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(adminAudit.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      staffEmail: row.staffEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      tenantId: row.tenantId,
      reason: row.reason,
      metadata: row.metadata,
    }));
  }
}
