import { Inject, Injectable } from "@nestjs/common";
import { Permission, parseQuantity, reorderRuleSchema } from "@bizora/contracts";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { findBranch, requireBusiness, requireProduct, resolveBranch } from "./inventory-scope.js";

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
const amount = (value: string | null | undefined) => (value === undefined || value === null ? null : value === "0" ? 0n : (parseQuantity(value) as bigint));
const text = (value: string | bigint | null | undefined) => (value === null || value === undefined ? null : value.toString());
const ZERO = "00000000-0000-0000-0000-000000000000";

type RuleRow = {
  branch_id: string | null;
  branch_name: string | null;
  reorder_point: string | null;
  min_quantity: string | null;
  target_quantity: string | null;
  max_quantity: string | null;
  lead_time_days: number | null;
  preferred_supplier_id: string | null;
  supplier_name: string | null;
};

/**
 * Reorder rules (ADR-063). The reorder point for every shop is the product's low stock level, so everything that
 * already says "Low" keeps working; a rule adds the minimum, what to fill up to, the most to keep, the usual
 * supplier and how long they take. A shop's own rule replaces the rule for every shop there.
 */
@Injectable()
export class ReorderService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** A product's rules: for every shop, and each shop's own, with the suppliers it can be bought from. */
  async rules(tenant: TenantContext, productId: string) {
    const business = await requireBusiness(this.db, tenant);
    const product = await requireProduct(this.db, tenant, business.id, productId);
    const shop = tenant.membershipBranchId ? sql`AND (r.branch_id IS NULL OR r.branch_id = ${tenant.membershipBranchId})` : sql``;
    const rows = rowsOf<RuleRow>(
      await this.db.execute(sql`
        SELECT r.branch_id, b.name AS branch_name, r.reorder_point::text AS reorder_point, r.min_quantity::text AS min_quantity,
          r.target_quantity::text AS target_quantity, r.max_quantity::text AS max_quantity, r.lead_time_days, r.preferred_supplier_id, s.name AS supplier_name
        FROM reorder_rules r
        LEFT JOIN branches b ON b.tenant_id = r.tenant_id AND b.id = r.branch_id
        LEFT JOIN suppliers s ON s.tenant_id = r.tenant_id AND s.id = r.preferred_supplier_id
        WHERE r.tenant_id = ${tenant.tenantId} AND r.business_id = ${business.id} AND r.product_id = ${product.id} ${shop}
        ORDER BY r.branch_id NULLS FIRST, b.name`),
    );
    const suppliers = rowsOf<{ id: string; name: string; preferred: boolean; lead_time_days: number | null }>(
      await this.db.execute(sql`
        SELECT s.id, s.name, sp.preferred, sp.lead_time_days FROM supplier_products sp
        JOIN suppliers s ON s.tenant_id = sp.tenant_id AND s.id = sp.supplier_id AND s.archived_at IS NULL AND NOT s.unnamed
        WHERE sp.tenant_id = ${tenant.tenantId} AND sp.business_id = ${business.id} AND sp.product_id = ${product.id}
        ORDER BY sp.preferred DESC, s.name`),
    );
    const everyShop = rows.find((row) => row.branch_id === null);
    const present = (row: RuleRow | undefined, branch: { id: string | null; name: string | null }, point: string | null) => ({
      branchId: branch.id,
      branchName: branch.name,
      reorderPoint: point,
      minQuantity: row?.min_quantity ?? null,
      targetQuantity: row?.target_quantity ?? null,
      maxQuantity: row?.max_quantity ?? null,
      leadTimeDays: row?.lead_time_days ?? null,
      preferredSupplierId: row?.preferred_supplier_id ?? null,
      supplierName: row?.supplier_name ?? null,
    });
    return {
      baseUnit: product.baseUnit,
      everyShop: present(everyShop, { id: null, name: null }, text(product.lowStockLevel)),
      shops: rows.filter((row) => row.branch_id !== null).map((row) => present(row, { id: row.branch_id, name: row.branch_name }, row.reorder_point)),
      suppliers: suppliers.map((row) => ({ id: row.id, name: row.name, preferred: row.preferred, leadTimeDays: row.lead_time_days })),
    };
  }

  /** Saves the rule for every shop (its reorder point is the low stock level), or one shop's own rule. */
  async save(tenant: TenantContext, productId: string, raw: unknown) {
    const payload = reorderRuleSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await requireProduct(tx, tenant, business.id, productId);
      if (!product.trackStock) throw new ApiError("STOCK_NOT_TRACKED", "Stock is not counted for this product, so it has no reorder rule.", 422);
      const branchId = await this.branchOf(tx, tenant, business.id, payload.branchId ?? null);
      if (payload.preferredSupplierId) await this.requireSupplier(tx, tenant, business.id, payload.preferredSupplierId);
      const point = amount(payload.reorderPoint) ?? 0n;
      if (branchId === null && text(point) !== text(product.lowStockLevel)) {
        await tx.execute(sql`UPDATE products SET low_stock_level = ${point}, updated_at = now() WHERE tenant_id = ${tenant.tenantId} AND id = ${product.id}`);
      }
      await tx.execute(sql`
        INSERT INTO reorder_rules (id, tenant_id, business_id, product_id, branch_id, reorder_point, min_quantity, target_quantity, max_quantity, lead_time_days, preferred_supplier_id, updated_by)
        VALUES (${newId()}, ${tenant.tenantId}, ${business.id}, ${product.id}, ${branchId}, ${branchId === null ? null : point}, ${amount(payload.minQuantity)},
          ${amount(payload.targetQuantity)}, ${amount(payload.maxQuantity)}, ${payload.leadTimeDays ?? null}, ${payload.preferredSupplierId ?? null}, ${tenant.userId})
        ON CONFLICT (tenant_id, product_id, coalesce(branch_id, ${ZERO}::uuid)) DO UPDATE SET
          reorder_point = EXCLUDED.reorder_point, min_quantity = EXCLUDED.min_quantity, target_quantity = EXCLUDED.target_quantity,
          max_quantity = EXCLUDED.max_quantity, lead_time_days = EXCLUDED.lead_time_days, preferred_supplier_id = EXCLUDED.preferred_supplier_id,
          updated_by = EXCLUDED.updated_by, updated_at = now()`);
      await this.record(tx, tenant, business.id, branchId, "stock.reorder_rule_saved", product.id, {
        reorderPoint: point.toString(),
        minQuantity: text(amount(payload.minQuantity)),
        targetQuantity: text(amount(payload.targetQuantity)),
        maxQuantity: text(amount(payload.maxQuantity)),
        leadTimeDays: payload.leadTimeDays ?? null,
        preferredSupplierId: payload.preferredSupplierId ?? null,
        ...(branchId === null && text(point) !== text(product.lowStockLevel) ? { lowStockLevel: [text(product.lowStockLevel), point.toString()] } : {}),
      });
    });
    return this.rules(tenant, productId);
  }

  /** Removes a shop's own rule, so the rule for every shop applies there again; or the rule for every shop. */
  async remove(tenant: TenantContext, productId: string, requestedBranchId?: string) {
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await requireProduct(tx, tenant, business.id, productId);
      const branchId = await this.branchOf(tx, tenant, business.id, requestedBranchId ?? null);
      await tx.execute(sql`
        DELETE FROM reorder_rules WHERE tenant_id = ${tenant.tenantId} AND product_id = ${product.id}
          AND ${branchId === null ? sql`branch_id IS NULL` : sql`branch_id = ${branchId}`}`);
      // Without a rule for every shop the product still keeps its low stock level, which the product form changes.
      await this.record(tx, tenant, business.id, branchId, "stock.reorder_rule_removed", product.id, {});
    });
    return this.rules(tenant, productId);
  }

  /**
   * What to buy for one shop: products at or below their reorder point there, with what is on the way, how much
   * fills up to the target (never past the most to keep), and the usual supplier with their last price.
   */
  async toBuy(tenant: TenantContext, requestedBranchId?: string) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, requestedBranchId);
    const seesCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const rows = rowsOf<{
      id: string;
      name: string;
      base_unit: string;
      on_hand: string;
      incoming: string;
      reorder_point: string;
      min_quantity: string | null;
      target_quantity: string | null;
      max_quantity: string | null;
      lead_time_days: number | null;
      supplier_id: string | null;
      supplier_name: string | null;
      unit_cost: string | null;
    }>(
      await this.db.execute(sql`
        WITH rules AS (
          SELECT p.id, p.name, p.base_unit, p.last_purchase_cost_minor,
            coalesce(own.reorder_point, p.low_stock_level) AS reorder_point,
            coalesce(own.min_quantity, every.min_quantity) AS min_quantity,
            coalesce(own.target_quantity, every.target_quantity) AS target_quantity,
            coalesce(own.max_quantity, every.max_quantity) AS max_quantity,
            coalesce(own.lead_time_days, every.lead_time_days) AS lead_time_days,
            coalesce(own.preferred_supplier_id, every.preferred_supplier_id) AS chosen_supplier_id,
            coalesce(sb.quantity, 0) AS on_hand,
            coalesce((
              SELECT sum(l.quantity) FROM stock_transfer_lines l
              JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
              WHERE l.tenant_id = p.tenant_id AND l.product_id = p.id AND t.status = 'dispatched' AND t.to_branch_id = ${branch.id}
            ), 0) AS incoming
          FROM products p
          LEFT JOIN reorder_rules own ON own.tenant_id = p.tenant_id AND own.product_id = p.id AND own.branch_id = ${branch.id}
          LEFT JOIN reorder_rules every ON every.tenant_id = p.tenant_id AND every.product_id = p.id AND every.branch_id IS NULL
          LEFT JOIN stock_balances sb ON sb.tenant_id = p.tenant_id AND sb.product_id = p.id AND sb.branch_id = ${branch.id}
          WHERE p.tenant_id = ${tenant.tenantId} AND p.business_id = ${business.id} AND p.archived_at IS NULL AND p.track_stock
        )
        SELECT r.id, r.name, r.base_unit, r.on_hand::text AS on_hand, r.incoming::text AS incoming, r.reorder_point::text AS reorder_point,
          r.min_quantity::text AS min_quantity, r.target_quantity::text AS target_quantity, r.max_quantity::text AS max_quantity,
          coalesce(r.lead_time_days, sup.lead_time_days) AS lead_time_days, sup.supplier_id, sup.name AS supplier_name,
          coalesce(sup.last_cost_minor, r.last_purchase_cost_minor)::text AS unit_cost
        FROM rules r
        LEFT JOIN LATERAL (
          SELECT sp.supplier_id, s.name, sp.last_cost_minor, sp.lead_time_days FROM supplier_products sp
          JOIN suppliers s ON s.tenant_id = sp.tenant_id AND s.id = sp.supplier_id AND NOT s.unnamed
          WHERE sp.tenant_id = ${tenant.tenantId} AND sp.product_id = r.id AND (r.chosen_supplier_id IS NULL OR sp.supplier_id = r.chosen_supplier_id)
          ORDER BY (sp.supplier_id = r.chosen_supplier_id) DESC NULLS LAST, sp.preferred DESC, sp.last_received_at DESC NULLS LAST
          LIMIT 1
        ) sup ON true
        WHERE r.reorder_point IS NOT NULL AND r.on_hand <= r.reorder_point
        ORDER BY sup.name NULLS LAST, r.name
        LIMIT 500`),
    );
    // A supplier chosen on the rule who has never delivered this product still names the supplier.
    const chosen = rowsOf<{ product_id: string; id: string; name: string }>(
      await this.db.execute(sql`
        SELECT DISTINCT ON (r.product_id) r.product_id, s.id, s.name FROM reorder_rules r
        JOIN suppliers s ON s.tenant_id = r.tenant_id AND s.id = r.preferred_supplier_id
        WHERE r.tenant_id = ${tenant.tenantId} AND r.business_id = ${business.id} AND (r.branch_id = ${branch.id} OR r.branch_id IS NULL)
        ORDER BY r.product_id, r.branch_id NULLS LAST`),
    );
    const chosenBy = new Map(chosen.map((row) => [row.product_id, row]));
    const items = rows.map((row) => {
      const onHand = BigInt(row.on_hand);
      const incoming = BigInt(row.incoming);
      const target = row.target_quantity === null ? null : BigInt(row.target_quantity);
      const max = row.max_quantity === null ? null : BigInt(row.max_quantity);
      const fillTo = target !== null && max !== null && max < target ? max : target;
      const toOrder = fillTo === null ? null : fillTo - onHand - incoming > 0n ? fillTo - onHand - incoming : 0n;
      const unitCost = row.unit_cost === null ? null : BigInt(row.unit_cost);
      const supplier = row.supplier_id ? { id: row.supplier_id, name: row.supplier_name } : (chosenBy.get(row.id) ?? null);
      return {
        productId: row.id,
        name: row.name,
        baseUnit: row.base_unit,
        onHand: row.on_hand,
        incoming: row.incoming,
        reorderPoint: row.reorder_point,
        minQuantity: row.min_quantity,
        targetQuantity: row.target_quantity,
        maxQuantity: row.max_quantity,
        belowMinimum: row.min_quantity !== null && onHand < BigInt(row.min_quantity),
        toOrder: text(toOrder),
        leadTimeDays: row.lead_time_days,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
        ...(seesCost ? { estimatedCostMinor: toOrder !== null && unitCost !== null ? ((toOrder * unitCost + 500n) / 1000n).toString() : null } : {}),
      };
    });
    return { branchId: branch.id, branchName: branch.name, items };
  }

  /** The shop a rule is for: none (every shop) is only for those who see every shop. */
  private async branchOf(tx: DbExecutor, tenant: TenantContext, businessId: string, branchId: string | null) {
    if (branchId === null) {
      if (tenant.membershipBranchId) throw new ApiError("FORBIDDEN", "Only someone who works across all shops can set the rule for every shop.", 403);
      return null;
    }
    if (tenant.membershipBranchId && tenant.membershipBranchId !== branchId) throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
    return (await findBranch(tx, tenant, businessId, branchId)).id;
  }

  private async requireSupplier(tx: DbExecutor, tenant: TenantContext, businessId: string, supplierId: string) {
    const [supplier] = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM suppliers WHERE tenant_id = ${tenant.tenantId} AND business_id = ${businessId} AND id = ${supplierId} AND archived_at IS NULL`),
    );
    if (!supplier) throw new ApiError("SUPPLIER_NOT_FOUND", "Supplier was not found.", 404, [{ field: "preferredSupplierId", message: "Choose a supplier from the list." }]);
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, branchId: string | null, action: string, productId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType: "product", entityId: productId, correlationId: tenant.correlationId, businessId, branchId, actorType: tenant.actorType ?? "HUMAN", metadata },
      tx,
    );
  }
}
