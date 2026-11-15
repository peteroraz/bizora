import { Injectable } from "@nestjs/common";
import { type DocumentType, formatOfficialNumber } from "@bizora/contracts";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../db/database.js";

/**
 * Official document numbers: one gap-free-as-possible sequence per business and document type (R-000001, …).
 * The upsert takes a row lock, so concurrent sales get distinct numbers. Call it inside the transaction that saves
 * the document; if that transaction rolls back, the number is not used. Devices show a provisional number
 * (DEV3-000045) until the server has issued this one.
 */
@Injectable()
export class DocumentNumberService {
  async next(executor: DbExecutor, tenantId: string, businessId: string, type: DocumentType) {
    const result = await executor.execute(sql`
      INSERT INTO document_sequences (tenant_id, business_id, document_type, next_value)
      VALUES (${tenantId}, ${businessId}, ${type}, 2)
      ON CONFLICT (tenant_id, business_id, document_type)
      DO UPDATE SET next_value = document_sequences.next_value + 1, updated_at = now()
      RETURNING next_value - 1 AS value`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { value: string | number | bigint }[];
    const value = BigInt(rows[0]?.value ?? 0);
    return { value, number: formatOfficialNumber(type, value) };
  }
}
