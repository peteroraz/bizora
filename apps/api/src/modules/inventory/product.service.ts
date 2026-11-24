import { Inject, Injectable } from "@nestjs/common";
import {
  compactItemKey,
  productArchiveSchema,
  Permission,
  PRODUCT_PAGE_SIZE,
  PULL_PAGE_SIZE,
  parseQuantity,
  productCreateSchema,
  productWriteSchema,
  isValidGtin,
  variantName,
} from "@bizora/contracts";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { auditEvents, branches, brands, catalogItems, categories, productUnits, products, stockBalances, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { type ProductRow, type ProductUnitRow, productUnitsFor, requireBusiness, requireProduct, resolveBranch } from "./inventory-scope.js";
import { categoryPath, copyCategoryToVariants, requireBrand, requireItem, resolveCategory } from "./catalog-scope.js";
import { mainPhotos } from "./product-photo.service.js";
import { StockService } from "./stock.service.js";
import { TransferService } from "./transfer.service.js";

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
    @Inject(TransferService) private readonly transfers: TransferService,
  ) {}

  async list(tenant: TenantContext, query: { q?: string; page?: number; category?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, query.branchId);
    const filters: SQL[] = [eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)];
    const needle = query.q?.trim();
    if (needle) {
      // Name, category and every code (ADR-046): barcode and GTIN exactly, SKU, MPN and reference in any case, brand by name.
      const code = needle.toLowerCase();
      const match = or(
        ilike(products.name, like(needle)),
        eq(products.barcode, needle),
        eq(products.gtin, needle),
        ilike(products.category, like(needle)),
        sql`lower(${products.sku}) = ${code}`,
        sql`lower(${products.mpn}) = ${code}`,
        sql`lower(${products.reference}) = ${code}`,
        sql`${products.catalogItemId} IN (SELECT i.id FROM catalog_items i JOIN brands b ON b.tenant_id = i.tenant_id AND b.id = i.brand_id WHERE i.tenant_id = ${tenant.tenantId} AND b.name ILIKE ${like(needle)})`,
      );
      // A supplier's own code for the product finds it too (ADR-048).
      const bySupplierCode = sql`EXISTS (SELECT 1 FROM supplier_products sp WHERE sp.tenant_id = ${products.tenantId} AND sp.product_id = ${products.id} AND lower(sp.supplier_sku) = ${code})`;
      if (match) filters.push(or(match, bySupplierCode) as SQL);
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
    const photos = await mainPhotos(this.db, tenant.tenantId, rows.map((row) => row.product.id));
    const totals = await this.totals(tenant, filters, branch.id);
    const categories = await this.db
      .selectDistinct({ category: products.category })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)))
      .orderBy(asc(products.category));
    return {
      items: rows.map((row) => ({ ...this.present(tenant, row.product, units.get(row.product.id) ?? [], row.balance), photoUrl: photos.get(row.product.id) ?? null })),
      page,
      pageSize: PRODUCT_PAGE_SIZE,
      total: Number(totalRow?.total ?? 0),
      branchId: branch.id,
      currency: business.baseCurrencyCode.trim(),
      categories: categories.map((row) => row.category).filter((value): value is string => Boolean(value)),
      totals,
    };
  }

  /**
   * Added up for every product the search or category matches, in this shop, not only the page shown: how many
   * products, how many are in stock, what the stock cost (cost read only) and what it sells for at list prices.
   * Stock below zero counts as none. Money stays whole minor units: numeric in SQL, never floating point.
   */
  private async totals(tenant: TenantContext, filters: SQL[], branchId: string) {
    const held = sql`greatest(coalesce(${stockBalances.quantity}, 0), 0)`;
    const [row] = await this.db
      .select({
        products: sql<number>`count(*)::int`,
        inStock: sql<number>`count(*) filter (where ${products.trackStock} and coalesce(${stockBalances.quantity}, 0) > 0)::int`,
        costValueMinor: sql<string>`coalesce(sum(case when ${products.trackStock} and coalesce(${stockBalances.quantity}, 0) > 0 then ${stockBalances.valueMinor} else 0 end), 0)::text`,
        sellingValueMinor: sql<string>`coalesce(round(sum(case when ${products.trackStock} then ${held}::numeric * coalesce(${products.priceMinor}, 0) else 0 end) / 1000), 0)::bigint::text`,
        withoutPrice: sql<number>`count(*) filter (where ${products.trackStock} and coalesce(${stockBalances.quantity}, 0) > 0 and ${products.priceMinor} is null)::int`,
      })
      .from(products)
      .leftJoin(
        stockBalances,
        and(eq(stockBalances.tenantId, products.tenantId), eq(stockBalances.productId, products.id), eq(stockBalances.branchId, branchId)),
      )
      .where(and(...filters));
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return {
      products: Number(row?.products ?? 0),
      inStock: Number(row?.inStock ?? 0),
      sellingValueMinor: row?.sellingValueMinor ?? "0",
      withoutPrice: Number(row?.withoutPrice ?? 0),
      ...(seeCost ? { costValueMinor: row?.costValueMinor ?? "0" } : {}),
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
    const [itemRow] = await this.db
      .select({ item: catalogItems, brandName: brands.name })
      .from(catalogItems)
      .leftJoin(brands, and(eq(brands.tenantId, catalogItems.tenantId), eq(brands.id, catalogItems.brandId)))
      .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.id, product.catalogItemId)))
      .limit(1);
    const siblings = await this.db
      .select({ id: products.id, variantLabel: products.variantLabel, name: products.name })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, product.catalogItemId), isNull(products.archivedAt)))
      .orderBy(asc(products.name));
    const transit = await this.transfers.inTransit(this.db, tenant.tenantId, product.id);
    // A place with stock on its way but none yet still shows, with what is coming.
    const waitingOnly = [...transit.keys()].filter((branchId) => !balances.some((row) => row.balance.branchId === branchId) && (!tenant.membershipBranchId || branchId === tenant.membershipBranchId));
    const waitingPlaces = waitingOnly.length
      ? await this.db.select({ id: branches.id, name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenant.tenantId), inArray(branches.id, waitingOnly)))
      : [];
    return {
      ...this.present(tenant, product, units, current),
      // The item this product is a variant of (ADR-046), and the other variants.
      item: itemRow
        ? {
            id: itemRow.item.id,
            name: itemRow.item.name,
            itemType: itemRow.item.itemType,
            categoryId: itemRow.item.categoryId,
            categoryPath: await categoryPath(this.db, tenant.tenantId, business.id, itemRow.item.categoryId),
            brandId: itemRow.item.brandId,
            brandName: itemRow.brandName,
            variants: siblings,
          }
        : null,
      photoUrl: (await mainPhotos(this.db, tenant.tenantId, [product.id])).get(product.id) ?? null,
      currency: business.baseCurrencyCode.trim(),
      shops: balances.map((row) => ({
        branchId: row.balance.branchId,
        branchName: row.branchName,
        ...this.presentBalance(tenant, product, row.balance),
        // Stock status (ADR-047): on its way here, or sent from here and not yet received.
        inTransitIn: (transit.get(row.balance.branchId)?.incoming ?? 0n).toString(),
        inTransitOut: (transit.get(row.balance.branchId)?.outgoing ?? 0n).toString(),
      })).concat(
        waitingPlaces.map((place) => ({
          branchId: place.id,
          branchName: place.name,
          quantity: "0",
          belowZero: false,
          inTransitIn: (transit.get(place.id)?.incoming ?? 0n).toString(),
          inTransitOut: (transit.get(place.id)?.outgoing ?? 0n).toString(),
        })) as never[],
      ),
      inTransit: [...transit.entries()]
        .filter(([branchId]) => !tenant.membershipBranchId || branchId === tenant.membershipBranchId)
        .map(([branchId, value]) => ({ branchId, incoming: value.incoming.toString(), outgoing: value.outgoing.toString() })),
    };
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = productCreateSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(products).where(eq(products.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = await this.db.transaction(async (tx) => this.createIn(tx, tenant, payload));
    return this.get(tenant, id);
  }

  /** Creates the product in the caller's transaction, so an item and all its variants are made together (ADR-046). */
  async createIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof productCreateSchema.parse> & { onlyVariant?: boolean }) {
    const business = await requireBusiness(tx, tenant);
    this.assertCostAllowed(tenant, payload.defaultCostMinor ?? payload.openingCostMinor);
    // A variant of an existing item takes the item's name with its own label (ADR-046).
    const parent = payload.catalogItemId ? await requireItem(tx, tenant, business.id, payload.catalogItemId) : null;
    if (parent && !payload.variantLabel && !payload.onlyVariant) throw new ApiError("VALIDATION_ERROR", "Give the variant a name, such as Black / Large.", 400, [{ field: "variantLabel", message: "Required." }]);
    const name = parent ? variantName(parent.name, payload.variantLabel) : payload.name;
    const trackStock = parent ? parent.itemType === "physical" && payload.trackStock !== false : payload.itemType ? payload.itemType === "physical" && payload.trackStock !== false : (payload.trackStock ?? true);
    await this.assertNameFree(tenant.tenantId, business.id, name, null, tx);
    await this.assertCodesFree(tenant.tenantId, business.id, payload, null, tx);
    const id = payload.id ?? newId();
    {
      const category = parent ? null : await resolveCategory(tx, tenant, business.id, { categoryId: payload.categoryId, categoryText: payload.category });
      const brand = !parent && payload.brandId ? await requireBrand(tx, tenant, business.id, payload.brandId) : null;
      await tx.insert(products).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        ...this.values({ ...payload, name, trackStock, category: parent ? null : (category?.name ?? null) }),
        ...(parent ? { catalogItemId: parent.id, variantLabel: payload.variantLabel ?? null, category: (await this.variantCategory(tx, parent)) ?? null } : {}),
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      if (!parent) {
        // The database made the product its own item (same ID); fill in what this request knows about it.
        await tx
          .update(catalogItems)
          .set({ itemType: payload.itemType ?? (trackStock ? "physical" : "non_stock"), categoryId: category?.id ?? null, brandId: brand?.id ?? null, updatedAt: new Date() })
          .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.id, id)));
      }
      await this.replacePacks(tx, tenant, business.id, id, payload.packs ?? []);
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "product.created", entityType: "product", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN" },
        tx,
      );
      if (payload.openingQuantity && trackStock) {
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
    }
    return id;
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
    await this.assertCodesFree(tenant.tenantId, business.id, payload, id);
    const item = await requireItem(this.db, tenant, business.id, existing.catalogItemId, { includeArchived: true });
    const [{ count: variantCount } = { count: 1 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, item.id), isNull(products.archivedAt)));
    const values = this.values({
      ...payload,
      trackStock: item.itemType === "physical" ? (payload.trackStock ?? existing.trackStock) : false,
      tracksBatches: payload.tracksBatches ?? existing.tracksBatches,
    });
    // Without permission to see cost, the existing default cost is kept as it is.
    const seesCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    if (!seesCost) delete (values as Partial<typeof values>).defaultCostMinor;
    // What changed, for the product's history (7f). A new selling price or cost says why.
    const text = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString());
    const changes: Record<string, [string | null, string | null]> = {};
    if (values.name !== existing.name) changes.name = [existing.name, values.name];
    if (text(values.priceMinor) !== text(existing.priceMinor)) changes.price = [text(existing.priceMinor), text(values.priceMinor)];
    if (seesCost && text(values.defaultCostMinor) !== text(existing.defaultCostMinor)) changes.cost = [text(existing.defaultCostMinor), text(values.defaultCostMinor)];
    if (text(values.lowStockLevel) !== text(existing.lowStockLevel)) changes.lowStockLevel = [text(existing.lowStockLevel), text(values.lowStockLevel)];
    if ((values.category ?? null) !== (existing.category ?? null)) changes.category = [existing.category ?? null, values.category ?? null];
    if (values.trackStock !== existing.trackStock) changes.trackStock = [String(existing.trackStock), String(values.trackStock)];
    if (values.tracksBatches !== existing.tracksBatches) changes.tracksBatches = [String(existing.tracksBatches), String(values.tracksBatches)];
    const reason = payload.changeReason?.trim() || null;
    if ((changes.price || changes.cost) && !reason) {
      throw new ApiError("REASON_REQUIRED", "Say why the price or cost is changing.", 400, [{ field: "changeReason", message: "Say why." }]);
    }
    await this.db.transaction(async (tx) => {
      // The item's category (ADR-046): by ID, or by the typed name. Shared by every variant, so only an item's only
      // variant may change it from here; an item with several is changed on the item.
      const singleVariant = variantCount <= 1;
      // The older form sends the category name back as it was; the same name means no change, so an item kept in
      // a sub-category is not moved to a top category of the same name.
      const sameText = payload.categoryId === undefined && (payload.category?.trim() || null) === (existing.category ?? null);
      const category =
        singleVariant && !sameText && (payload.categoryId !== undefined || payload.category !== undefined)
          ? await resolveCategory(tx, tenant, business.id, { categoryId: payload.categoryId, categoryText: payload.category })
          : undefined;
      const brand = singleVariant && payload.brandId ? await requireBrand(tx, tenant, business.id, payload.brandId) : undefined;
      if (category !== undefined) values.category = category?.name ?? null;
      else values.category = existing.category;
      await tx.update(products).set({ ...values, updatedBy: tenant.userId, updatedAt: new Date() }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, id)));
      if (singleVariant) {
        await tx
          .update(catalogItems)
          .set({
            ...(!existing.variantLabel ? { name: values.name } : {}),
            ...(category !== undefined ? { categoryId: category?.id ?? null } : {}),
            ...(brand !== undefined ? { brandId: brand.id } : payload.brandId === null ? { brandId: null } : {}),
            updatedAt: new Date(),
            updatedBy: tenant.userId,
          })
          .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.id, item.id)));
        if (category !== undefined) await copyCategoryToVariants(tx, tenant.tenantId, item.id, category?.name ?? null);
      }
      if (payload.packs) await this.replacePacks(tx, tenant, business.id, id, payload.packs);
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "product.updated",
          entityType: "product",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: { changes, reason, packsChanged: Boolean(payload.packs) },
        },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  /**
   * The product's own changes (name, price, cost, low-stock level) and rejected counts, with the reasons given (7f).
   * Stock movements are listed separately; together they are the product's history. Cost changes are only shown to
   * people who may see cost.
   */
  async changes(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    await requireProduct(this.db, tenant, business.id, id, { includeArchived: true });
    const rows = await this.db
      .select({ event: auditEvents, byName: users.displayName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(
        and(
          eq(auditEvents.tenantId, tenant.tenantId),
          eq(auditEvents.entityType, "product"),
          eq(auditEvents.entityId, id),
          inArray(auditEvents.action, ["product.updated", "product.archived", "stock.count_rejected", "product.photo_added", "product.photo_removed", "stock.requested", "stock.request_approved", "stock.request_rejected"]),
          ...(tenant.membershipBranchId ? [or(isNull(auditEvents.branchId), eq(auditEvents.branchId, tenant.membershipBranchId)) as SQL] : []),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(50);
    const seesCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return rows
      .map(({ event, byName }) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = event.metadataJson ? (JSON.parse(event.metadataJson) as Record<string, unknown>) : {};
        } catch {
          metadata = {};
        }
        const changes = { ...((metadata.changes as Record<string, [string | null, string | null]> | undefined) ?? {}) };
        const changedSomething = Object.keys(changes).length > 0;
        if (!seesCost) delete changes.cost;
        // A change only to cost is hidden whole (with its reason) from people who may not see cost.
        const onlyHidden = changedSomething && Object.keys(changes).length === 0;
        return {
          id: event.id,
          action: event.action,
          at: event.createdAt.toISOString(),
          byName,
          reason: (metadata.reason as string | null | undefined) ?? (metadata.note as string | null | undefined) ?? null,
          changes,
          onlyHidden,
          ...(event.action.startsWith("stock.request") ? { summary: (metadata.summary as string | undefined) ?? null } : {}),
          ...(event.action === "stock.count_rejected"
            ? { countedQuantity: (metadata.countedQuantity as string | undefined) ?? null, countNote: (metadata.countNote as string | null | undefined) ?? null }
            : {}),
        };
      })
      // A save that changed nothing worth showing (packs only, or cost hidden) without a reason is left out.
      .filter((item) => !item.onlyHidden && (item.action !== "product.updated" || Object.keys(item.changes).length > 0 || item.reason))
      .map(({ onlyHidden: _hidden, ...item }) => item);
  }

  async archive(tenant: TenantContext, id: string, raw: unknown = {}) {
    const { reason } = productArchiveSchema.parse(raw ?? {});
    const business = await requireBusiness(this.db, tenant);
    await requireProduct(this.db, tenant, business.id, id);
    await this.db.update(products).set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: tenant.userId }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, id)));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "product.archived",
      entityType: "product",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      metadata: { reason: reason ?? null },
    });
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
        .map((unit) => ({ unitCode: unit.unitCode, baseQuantity: unit.baseQuantity.toString(), priceMinor: unit.priceMinor?.toString() ?? null, forPurchase: unit.forPurchase, forSale: unit.forSale }))
        .sort((a, b) => Number(BigInt(a.baseQuantity) - BigInt(b.baseQuantity))),
      lowStockLevel: product.lowStockLevel?.toString() ?? null,
      barcode: product.barcode,
      catalogItemId: product.catalogItemId,
      variantLabel: product.variantLabel,
      sku: product.sku,
      gtin: product.gtin,
      mpn: product.mpn,
      reference: product.reference,
      trackStock: product.trackStock,
      tracksBatches: product.tracksBatches,
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
      compactKey: compactItemKey(payload.name),
      category: payload.category?.trim() || null,
      baseUnit: payload.baseUnit,
      priceMinor: payload.priceMinor ? BigInt(payload.priceMinor) : null,
      defaultCostMinor: payload.defaultCostMinor ? BigInt(payload.defaultCostMinor) : null,
      lowStockLevel: payload.lowStockLevel ? (payload.lowStockLevel === "0" ? 0n : (parseQuantity(payload.lowStockLevel) as bigint)) : null,
      barcode: payload.barcode?.trim() || null,
      trackStock: payload.trackStock ?? true,
      // Batches only mean something for stock that is counted (ADR-061).
      tracksBatches: (payload.trackStock ?? true) && (payload.tracksBatches ?? false),
      sku: payload.sku?.trim() || null,
      gtin: payload.gtin?.trim() || null,
      mpn: payload.mpn?.trim() || null,
      reference: payload.reference?.trim() || null,
    };
  }

  /** The category name to show on a new variant: its item's. */
  private async variantCategory(executor: DbExecutor, item: { tenantId: string; businessId: string; categoryId: string | null }) {
    if (!item.categoryId) return null;
    const [row] = await executor.select({ name: categories.name }).from(categories).where(and(eq(categories.tenantId, item.tenantId), eq(categories.id, item.categoryId))).limit(1);
    return row?.name ?? null;
  }

  /** A SKU is the business's own code: one product in use per SKU. A GTIN must have a right check digit. */
  private async assertCodesFree(tenantId: string, businessId: string, payload: { sku?: string | null | undefined; gtin?: string | null | undefined }, exceptId: string | null, executor: DbExecutor = this.db) {
    const gtin = payload.gtin?.trim();
    if (gtin && !isValidGtin(gtin)) {
      throw new ApiError("VALIDATION_ERROR", "This GTIN is not right: check the digits.", 400, [{ field: "gtin", message: "Check the digits." }]);
    }
    const sku = payload.sku?.trim();
    if (!sku) return;
    const [taken] = await executor
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`lower(${products.sku}) = lower(${sku})`))
      .limit(1);
    if (taken && taken.id !== exceptId) {
      throw new ApiError("DUPLICATE_SKU", `This SKU is already used by ${taken.name}.`, 409, [{ field: "sku", message: taken.id }]);
    }
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
        forPurchase: pack.forPurchase ?? true,
        forSale: pack.forSale ?? true,
      })),
    );
  }

  private assertCostAllowed(tenant: TenantContext, cost: string | null | undefined) {
    if (cost && !tenant.permissions.includes(Permission.PRICES_COST_READ)) {
      throw new ApiError("FORBIDDEN", "Only someone who can see cost prices can set them.", 403, [{ field: "defaultCostMinor", message: "Leave cost empty." }]);
    }
  }

  private async assertNameFree(tenantId: string, businessId: string, name: string, exceptId: string | null, executor: DbExecutor = this.db) {
    const [taken] = await executor
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`lower(${products.name}) = lower(${name.trim()})`))
      .limit(1);
    if (taken && taken.id !== exceptId) {
      throw new ApiError("DUPLICATE_PRODUCT", "A product with this name already exists.", 409, [{ field: "name", message: taken.id }]);
    }
  }
}
