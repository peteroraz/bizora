import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { DB } from "../../tokens.js";
import { requireBusiness, requireProduct, resolveBranch } from "./inventory-scope.js";

/** The expiry list looks this many days ahead unless asked otherwise (ADR-061). */
export const EXPIRY_WARNING_DAYS = 30;

type BatchRow = {
  id: string;
  product_id: string;
  product_name: string;
  base_unit: string;
  batch_number: string | null;
  expiry_date: string | null;
  manufactured_date: string | null;
  supplier_name: string | null;
  quantity: string;
  received_quantity: string;
  first_received_at: string;
};

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];

/** Reading batches and what is close to its expiry date (ADR-061). Changes go through StockService.applyMovement. */
@Injectable()
export class BatchService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  /** A product's batches in one shop, earliest expiry first, with how many days are left. */
  async forProduct(tenant: TenantContext, productId: string, branchId?: string) {
    const business = await requireBusiness(this.db, tenant);
    const product = await requireProduct(this.db, tenant, business.id, productId);
    const branch = await resolveBranch(this.db, tenant, business.id, branchId);
    const today = localDate(new Date(), business.timezone);
    const rows = rowsOf<BatchRow>(
      await this.db.execute(sql`
        SELECT b.id, b.product_id, p.name AS product_name, p.base_unit, b.batch_number, b.expiry_date::text AS expiry_date,
          b.manufactured_date::text AS manufactured_date, s.name AS supplier_name, b.quantity::text AS quantity,
          b.received_quantity::text AS received_quantity, b.first_received_at::text AS first_received_at
        FROM stock_batches b
        JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
        LEFT JOIN suppliers s ON s.tenant_id = b.tenant_id AND s.id = b.supplier_id
        WHERE b.tenant_id = ${tenant.tenantId} AND b.business_id = ${business.id} AND b.branch_id = ${branch.id}
          AND b.product_id = ${product.id} AND b.quantity > 0
        ORDER BY b.expiry_date ASC NULLS LAST, b.first_received_at ASC
        LIMIT 200`),
    );
    return { tracksBatches: product.tracksBatches, branchId: branch.id, items: rows.map((row) => present(row, today)) };
  }

  /** Stock in one shop that is past its expiry date or will be within `days` days, soonest first. */
  async expiring(tenant: TenantContext, branchId?: string, days?: string) {
    const within = days === undefined ? EXPIRY_WARNING_DAYS : Number(days);
    if (!Number.isInteger(within) || within < 0 || within > 365) {
      throw new ApiError("VALIDATION_FAILED", "Choose between 0 and 365 days.", 400, [{ field: "days", message: "Between 0 and 365." }]);
    }
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, branchId);
    const today = localDate(new Date(), business.timezone);
    const rows = rowsOf<BatchRow>(
      await this.db.execute(sql`
        SELECT b.id, b.product_id, p.name AS product_name, p.base_unit, b.batch_number, b.expiry_date::text AS expiry_date,
          b.manufactured_date::text AS manufactured_date, s.name AS supplier_name, b.quantity::text AS quantity,
          b.received_quantity::text AS received_quantity, b.first_received_at::text AS first_received_at
        FROM stock_batches b
        JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id AND p.archived_at IS NULL
        LEFT JOIN suppliers s ON s.tenant_id = b.tenant_id AND s.id = b.supplier_id
        WHERE b.tenant_id = ${tenant.tenantId} AND b.business_id = ${business.id} AND b.branch_id = ${branch.id}
          AND b.quantity > 0 AND b.expiry_date IS NOT NULL
          AND b.expiry_date <= (${today}::date + ${within}::int)
        ORDER BY b.expiry_date ASC, p.name ASC
        LIMIT 200`),
    );
    const items = rows.map((row) => present(row, today));
    return {
      branchId: branch.id,
      days: within,
      expired: items.filter((item) => item.status === "expired").length,
      soon: items.filter((item) => item.status === "soon").length,
      items,
    };
  }
}

function present(row: BatchRow, today: string) {
  const daysLeft = row.expiry_date ? Math.round((Date.parse(`${row.expiry_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    baseUnit: row.base_unit,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    manufacturedDate: row.manufactured_date,
    supplierName: row.supplier_name,
    quantity: row.quantity,
    receivedQuantity: row.received_quantity,
    receivedAt: row.first_received_at,
    daysLeft,
    status: daysLeft === null ? ("none" as const) : daysLeft < 0 ? ("expired" as const) : daysLeft <= EXPIRY_WARNING_DAYS ? ("soon" as const) : ("ok" as const),
  };
}
