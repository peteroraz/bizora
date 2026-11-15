import { Inject, Injectable } from "@nestjs/common";
import {
  Permission,
  PRODUCT_PAGE_SIZE,
  PULL_PAGE_SIZE,
  parseQuantity,
  productCreateSchema,
  productWriteSchema,
} from "@bizora/contracts";
import { and, asc, eq, gt, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, productUnits, products, stockBalances } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { type ProductRow, type ProductUnitRow, productUnitsFor, requireBusiness, requireProduct, resolveBranch } from "./inventory-scope.js";
import { StockService } from "./stock.service.js";

type BalanceRow = typeof stockBalances.$inferSelect;

function like(value: string) {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Products: what a business sells or keeps in stock. Selling prices are visible to everyone with stock.read;
 * cost (default cost, stock value) only with prices.cost.read (ADR-011).
 */
@Injectable()
export class ProductService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, query: { q?: string; page?: number; category?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, query.branchId);
    const filters: SQL[] = [eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)];
    const needle = query.q?.trim();
    if (needle) {
      const match = or(ilike(products.name, like(needle)), eq(products.barcode, needle), ilike(products.category, like(needle)));
      if (match) filters.push(match);
    }
    if (query.category?.trim()) filters.push(eq(products.category, query.category.trim()));
    const page = Math.max(1, query.page ?? 1);
    const [totalRow] = await this.db.select({ total: sql<number>`count(*)::int` }).from(products).where(and(...filters));
    const rows = await this.db
      .select({ product: products, balance: stockBalances })
      .from(products)
      .leftJoin(
        stockBalances,
        and(eq(stockBalances.tenantId, products.tenantId), eq(stockBalances.productId, products.id), eq(stockBalances.branchId, branch.id)),
      )
      .where(and(...filters))
      .orderBy(asc(products.name), asc(products.id))
      .limit(PRODUCT_PAGE_SIZE)
      .offset((page - 1) * PRODUCT_PAGE_SIZE);
    const units = await productUnitsFor(this.db, tenant.tenantId, rows.map((row) => row.product.id));
    const categories = await this.db
      .selectDistinct({ category: products.category })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)))
      .orderBy(asc(products.category));
    return {
      items: rows.map((row) => this.present(tenant, row.product, units.get(row.product.id) ?? [], row.balance)),
      page,
      pageSize: PRODUCT_PAGE_SIZE,
      total: Number(totalRow?.total ?? 0),
      branchId: branch.id,
      currency: business.baseCurrencyCode.trim(),
      categories: categories.map((row) => row.category).filter((value): value is string => Boolean(value)),
    };
  }

  async get(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const product = await requireProduct(this.db, tenant, business.id, id, { includeArchived: true });
    const units = (await productUnitsFor(this.db, tenant.tenantId, [product.id])).get(product.id) ?? [];
    const filters = [eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.productId, product.id)];
    if (tenant.membershipBranchId) filters.push(eq(stockBalances.branchId, tenant.membershipBranchId));
    const balances = await this.db
      .select({ balance: stockBalances, branchName: branches.name })
      .from(stockBalances)
      .innerJoin(branches, and(eq(branches.tenantId, stockBalances.tenantId), eq(branches.id, stockBalances.branchId)))
      .where(and(...filters))
      .orderBy(asc(branches.name));
    const current = balances.find((row) => row.balance.branchId === tenant.branchId)?.balance ?? null;
    return {
      ...this.present(tenant, product, units, current),
      currency: business.baseCurrencyCode.trim(),
      shops: balances.map((row) => ({
        branchId: row.balance.branchId,
        branchName: row.branchName,
        ...this.presentBalance(tenant, product, row.balance),
      })),
    };
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = productCreateSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(products).where(eq(products.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const business = await requireBusiness(this.db, tenant);
    this.assertCostAllowed(tenant, payload.defaultCostMinor ?? payload.openingCostMinor);
    await this.assertNameFree(tenant.tenantId, business.id, payload.name, null);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(products).values({ id, tenantId: tenant.tenantId, businessId: business.id, ...this.values(payload), createdBy: tenant.userId, updatedBy: tenant.userId });
      await this.replacePacks(tx, tenant, business.id, id, payload.packs ?? []);
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "product.created", entityType: "product", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN" },
        tx,
      );
      if (payload.openingQuantity && payload.trackStock !== false) {
        const context = await this.stock.context(tx, tenant, id);
        const quantity = parseQuantity(payload.openingQuantity) as bigint;
        await this.stock.applyMovement(tx, context, {
          type: "opening",
          quantity,
          enteredQuantity: quantity,
          enteredUnit: payload.baseUnit,
          totalCostMinor: payload.openingCostMinor ? BigInt(payload.openingCostMinor) : null,
          documentType: "stock_in",
        });
      }
    });
    return this.get(tenant, id);
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const payload = productWriteSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const existing = await requireProduct(this.db, tenant, business.id, id);
    this.assertCostAllowed(tenant, payload.defaultCostMinor);
    await this.assertNameFree(tenant.tenantId, business.id, payload.name, id);
    if (payload.baseUnit !== existing.baseUnit) {
      const [moved] = await this.db.execute(sql`SELECT 1 AS moved FROM stock_movements WHERE tenant_id = ${tenant.tenantId} AND product_id = ${id} LIMIT 1`).then(
        (result) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as unknown[],
      );
      if (moved) throw new ApiError("UNIT_LOCKED", "The counting unit cannot change once stock has been recorded.", 422, [{ field: "baseUnit", message: "Keep the same unit." }]);
    }
    const values = this.values(payload);
    // Without permission to see cost, the existing default cost is kept as it is.
    if (!tenant.permissions.includes(Permission.PRICES_COST_READ)) delete (values as Partial<typeof values>).defaultCostMinor;
    await this.db.transaction(async (tx) => {
      await tx.update(products).set({ ...values, updatedBy: tenant.userId, updatedAt: new Date() }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, id)));
      if (payload.packs) await this.replacePacks(tx, tenant, business.id, id, payload.packs);
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "product.updated", entityType: "product", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN" },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  async archive(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    await requireProduct(this.db, tenant, business.id, id);
    await this.db.update(products).set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: tenant.userId }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, id)));
    await this.audit.record({ tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "product.archived", entityType: "product", entityId: id, correlationId: tenant.correlationId, businessId: business.id });
    return { archived: true };
  }

  /**
   * Offline download: products changed since the cursor (archived ones too, so the device can drop them) and this
   * shop's quantities changed since theirs. Each page holds up to PULL_PAGE_SIZE rows; repeat until `done`.
   */
  async pull(tenant: TenantContext, cursors: { products?: string; balances?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id);
    const productCursor = this.parseCursor(cursors.products);
    const balanceCursor = this.parseCursor(cursors.balances);
    const productFilters: SQL[] = [eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id)];
    if (productCursor) {
      const after = or(gt(products.updatedAt, productCursor.at), and(eq(products.updatedAt, productCursor.at), gt(products.id, productCursor.id)));
      if (after) productFilters.push(after);
    }
    const productRows = await this.db
      .select()
      .from(products)
      .where(and(...productFilters))
      .orderBy(asc(products.updatedAt), asc(products.id))
      .limit(PULL_PAGE_SIZE);
    const units = await productUnitsFor(this.db, tenant.tenantId, productRows.map((row) => row.id));

    const balanceFilters: SQL[] = [eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, branch.id)];
    if (balanceCursor) {
      const after = or(
        gt(stockBalances.updatedAt, balanceCursor.at),
        and(eq(stockBalances.updatedAt, balanceCursor.at), gt(stockBalances.productId, balanceCursor.id)),
      );
      if (after) balanceFilters.push(after);
    }
    const balanceRows = await this.db
      .select()
      .from(stockBalances)
      .where(and(...balanceFilters))
      .orderBy(asc(stockBalances.updatedAt), asc(stockBalances.productId))
      .limit(PULL_PAGE_SIZE);

    const lastProduct = productRows.at(-1);
    const lastBalance = balanceRows.at(-1);
    return {
      branchId: branch.id,
      currency: business.baseCurrencyCode.trim(),
      products: productRows.map((row) => ({ ...this.present(tenant, row, units.get(row.id) ?? [], null), archived: row.archivedAt !== null })),
      balances: balanceRows.map((row) => ({ productId: row.productId, ...this.presentBalance(tenant, null, row) })),
      cursors: {
        products: lastProduct ? `${lastProduct.updatedAt.toISOString()}|${lastProduct.id}` : (cursors.products ?? null),
        balances: lastBalance ? `${lastBalance.updatedAt.toISOString()}|${lastBalance.productId}` : (cursors.balances ?? null),
      },
      done: productRows.length < PULL_PAGE_SIZE && balanceRows.length < PULL_PAGE_SIZE,
    };
  }

  private parseCursor(cursor?: string) {
    if (!cursor) return null;
    const [at, id] = cursor.split("|");
    const date = new Date(at ?? "");
    if (!id || Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ApiError("VALIDATION_ERROR", "The sync cursor is not valid.", 400);
    }
    return { at: date, id };
  }

  private present(tenant: TenantContext, product: ProductRow, units: ProductUnitRow[], balance: BalanceRow | null) {
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return {
      id: product.id,
      name: product.name,
      category: product.category,
      baseUnit: product.baseUnit,
      priceMinor: product.priceMinor?.toString() ?? null,
      packs: units
        .map((unit) => ({ unitCode: unit.unitCode, baseQuantity: unit.baseQuantity.toString(), priceMinor: unit.priceMinor?.toString() ?? null }))
        .sort((a, b) => Number(BigInt(a.baseQuantity) - BigInt(b.baseQuantity))),
      lowStockLevel: product.lowStockLevel?.toString() ?? null,
      barcode: product.barcode,
      trackStock: product.trackStock,
      archived: product.archivedAt !== null,
      updatedAt: product.updatedAt,
      ...(seeCost ? { defaultCostMinor: product.defaultCostMinor?.toString() ?? null } : {}),
      stock: this.presentBalance(tenant, product, balance),
    };
  }

  private presentBalance(tenant: TenantContext, product: ProductRow | null, balance: BalanceRow | null) {
    const quantity = balance?.quantity ?? 0n;
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return {
      quantity: quantity.toString(),
      belowZero: quantity < 0n,
      ...(product ? { low: product.trackStock && product.lowStockLevel !== null && quantity <= product.lowStockLevel } : {}),
      ...(seeCost ? { valueMinor: (balance?.valueMinor ?? 0n).toString() } : {}),
    };
  }

  private values(payload: ReturnType<typeof productWriteSchema.parse>) {
    return {
      name: payload.name,
      category: payload.category?.trim() || null,
      baseUnit: payload.baseUnit,
      priceMinor: payload.priceMinor ? BigInt(payload.priceMinor) : null,
      defaultCostMinor: payload.defaultCostMinor ? BigInt(payload.defaultCostMinor) : null,
      lowStockLevel: payload.lowStockLevel ? (payload.lowStockLevel === "0" ? 0n : (parseQuantity(payload.lowStockLevel) as bigint)) : null,
      barcode: payload.barcode?.trim() || null,
      trackStock: payload.trackStock ?? true,
    };
  }

  private async replacePacks(tx: DbExecutor, tenant: TenantContext, businessId: string, productId: string, packs: NonNullable<ReturnType<typeof productWriteSchema.parse>["packs"]>) {
    const codes = new Set<string>();
    for (const pack of packs) {
      if (codes.has(pack.unitCode)) throw new ApiError("VALIDATION_ERROR", "Each pack size can be added once.", 400, [{ field: "packs", message: "Remove the repeated pack." }]);
      codes.add(pack.unitCode);
    }
    await tx.delete(productUnits).where(and(eq(productUnits.tenantId, tenant.tenantId), eq(productUnits.productId, productId)));
    if (packs.length === 0) return;
    await tx.insert(productUnits).values(
      packs.map((pack) => ({
        id: newId(),
        tenantId: tenant.tenantId,
        businessId,
        productId,
        unitCode: pack.unitCode,
        baseQuantity: parseQuantity(pack.baseQuantity) as bigint,
        priceMinor: pack.priceMinor ? BigInt(pack.priceMinor) : null,
      })),
    );
  }

  private assertCostAllowed(tenant: TenantContext, cost: string | null | undefined) {
    if (cost && !tenant.permissions.includes(Permission.PRICES_COST_READ)) {
      throw new ApiError("FORBIDDEN", "Only someone who can see cost prices can set them.", 403, [{ field: "defaultCostMinor", message: "Leave cost empty." }]);
    }
  }

  private async assertNameFree(tenantId: string, businessId: string, name: string, exceptId: string | null) {
    const [taken] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`lower(${products.name}) = lower(${name.trim()})`))
      .limit(1);
    if (taken && taken.id !== exceptId) {
      throw new ApiError("DUPLICATE_PRODUCT", "A product with this name already exists.", 409, [{ field: "name", message: taken.id }]);
    }
  }
}
