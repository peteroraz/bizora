import { Inject, Injectable } from "@nestjs/common";
import {
  CATEGORY_MAX_DEPTH,
  PRODUCT_PAGE_SIZE,
  Permission,
  brandWriteSchema,
  catalogItemArchiveSchema,
  catalogItemCreateSchema,
  catalogItemUpdateSchema,
  categoryWriteSchema,
  nameKey,
  addVariantSchema,
  variantCreateSchema,
  variantName,
} from "@bizora/contracts";
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { brands, catalogItems, categories, products, stockBalances, stockMovements } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { categoryAndBelow, categoryPath, copyCategoryToVariants, requireBrand, requireCategory, requireItem } from "./catalog-scope.js";
import { requireBusiness } from "./inventory-scope.js";
import { AttributeService } from "./attribute.service.js";
import { ProductService } from "./product.service.js";

const like = (value: string) => `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, message: string) => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) throw new ApiError("VALIDATION_ERROR", message, 400, result.error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "form", message: issue.message })));
  return result.data;
};

/**
 * The catalog (ADR-046): items, their variants (products), categories and brands. Stock, sales and the books keep
 * working on products exactly as before; this service only adds the layer above them.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AttributeService) private readonly attributes: AttributeService,
  ) {}

  // Categories

  async categories(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select()
      .from(categories)
      .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.businessId, business.id)))
      .orderBy(asc(categories.position), asc(categories.name));
    const counts = await this.db
      .select({ categoryId: catalogItems.categoryId, count: sql<number>`count(*)::int` })
      .from(catalogItems)
      .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.businessId, business.id), isNull(catalogItems.archivedAt)))
      .groupBy(catalogItems.categoryId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const depthOf = (row: (typeof rows)[number]) => {
      let depth = 0;
      for (let at = row; at.parentId && depth <= CATEGORY_MAX_DEPTH; depth += 1) {
        const parent = byId.get(at.parentId);
        if (!parent) break;
        at = parent;
      }
      return depth;
    };
    const pathOf = (row: (typeof rows)[number]) => {
      const names = [row.name];
      for (let at = row, depth = 0; at.parentId && depth <= CATEGORY_MAX_DEPTH; depth += 1) {
        const parent = byId.get(at.parentId);
        if (!parent) break;
        names.unshift(parent.name);
        at = parent;
      }
      return names.join(" › ");
    };
    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        position: row.position,
        active: row.active,
        taxonomyCode: row.taxonomyCode,
        depth: depthOf(row),
        path: pathOf(row),
        itemCount: counts.find((count) => count.categoryId === row.id)?.count ?? 0,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async createCategory(tenant: TenantContext, raw: unknown) {
    const payload = parse(categoryWriteSchema, raw, "Check the category.");
    const business = await requireBusiness(this.db, tenant);
    if (payload.parentId) await this.assertDepth(this.db, tenant, business.id, payload.parentId, 1);
    const id = newId();
    try {
      await this.db.insert(categories).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        parentId: payload.parentId ?? null,
        name: payload.name.replace(/\s+/g, " "),
        nameKey: nameKey(payload.name),
        position: payload.position ?? 0,
        active: payload.active ?? true,
        taxonomyCode: payload.taxonomyCode ?? null,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
    } catch (error) {
      throw this.duplicate(error, "A category with this name is already there.") ?? error;
    }
    await this.record(tenant, business.id, "category.created", "category", id, { name: payload.name, parentId: payload.parentId ?? null });
    return (await this.categories(tenant)).find((row) => row.id === id);
  }

  async updateCategory(tenant: TenantContext, id: string, raw: unknown) {
    const payload = parse(categoryWriteSchema.partial(), raw, "Check the category.");
    const business = await requireBusiness(this.db, tenant);
    const existing = await requireCategory(this.db, tenant, business.id, id);
    if (payload.parentId !== undefined && payload.parentId !== existing.parentId && payload.parentId !== null) {
      // A category cannot go under itself or anything under it.
      const below = await categoryAndBelow(this.db, tenant.tenantId, business.id, id);
      if (below.includes(payload.parentId)) throw new ApiError("CATEGORY_LOOP", "A category cannot go inside itself or one of its own categories.", 422, [{ field: "parentId", message: "Choose another." }]);
      const height = await this.heightBelow(tenant, business.id, id);
      await this.assertDepth(this.db, tenant, business.id, payload.parentId, height + 1);
    }
    try {
      await this.db
        .update(categories)
        .set({
          ...(payload.name !== undefined ? { name: payload.name.replace(/\s+/g, " "), nameKey: nameKey(payload.name) } : {}),
          ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
          ...(payload.position !== undefined ? { position: payload.position } : {}),
          ...(payload.active !== undefined ? { active: payload.active } : {}),
          ...(payload.taxonomyCode !== undefined ? { taxonomyCode: payload.taxonomyCode } : {}),
          updatedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.id, id)));
    } catch (error) {
      throw this.duplicate(error, "A category with this name is already there.") ?? error;
    }
    if (payload.name !== undefined && payload.name !== existing.name) {
      const items = await this.db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.categoryId, id)));
      for (const item of items) await copyCategoryToVariants(this.db, tenant.tenantId, item.id, payload.name.replace(/\s+/g, " "));
    }
    await this.record(tenant, business.id, "category.updated", "category", id, { from: { name: existing.name, parentId: existing.parentId, active: existing.active }, to: payload });
    return (await this.categories(tenant)).find((row) => row.id === id);
  }

  private async assertDepth(executor: DbExecutor, tenant: TenantContext, businessId: string, parentId: string, adding: number) {
    const parent = await requireCategory(executor, tenant, businessId, parentId);
    if (!parent.active) throw new ApiError("CATEGORY_INACTIVE", `"${parent.name}" is no longer in use. Choose another category.`, 422, [{ field: "parentId", message: "Not in use." }]);
    const path = (await categoryPath(executor, tenant.tenantId, businessId, parentId)) ?? "";
    const depth = path.split(" › ").length;
    if (depth + adding > CATEGORY_MAX_DEPTH) {
      throw new ApiError("CATEGORY_TOO_DEEP", `Categories go at most ${CATEGORY_MAX_DEPTH} levels deep.`, 422, [{ field: "parentId", message: "Choose a higher category." }]);
    }
  }

  private async heightBelow(tenant: TenantContext, businessId: string, id: string) {
    const rows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.businessId, businessId)));
    const height = (at: string, depth: number): number => (depth > CATEGORY_MAX_DEPTH ? depth : Math.max(0, ...rows.filter((row) => row.parentId === at).map((row) => 1 + height(row.id, depth + 1))));
    return height(id, 0);
  }

  // Brands

  async brands(tenant: TenantContext, q?: string) {
    const business = await requireBusiness(this.db, tenant);
    const filters: SQL[] = [eq(brands.tenantId, tenant.tenantId), eq(brands.businessId, business.id)];
    if (q?.trim()) filters.push(ilike(brands.name, like(q.trim())));
    const rows = await this.db.select().from(brands).where(and(...filters)).orderBy(asc(brands.name)).limit(200);
    return rows.map((row) => this.presentBrand(row));
  }

  async createBrand(tenant: TenantContext, raw: unknown) {
    const payload = parse(brandWriteSchema, raw, "Check the brand.");
    const business = await requireBusiness(this.db, tenant);
    const key = nameKey(payload.name);
    const [existing] = await this.db
      .select()
      .from(brands)
      .where(and(eq(brands.tenantId, tenant.tenantId), eq(brands.businessId, business.id), eq(brands.nameKey, key)))
      .limit(1);
    if (existing) throw new ApiError("DUPLICATE_BRAND", `${existing.name} is already a brand.`, 409, [{ field: "name", message: existing.id }]);
    const id = newId();
    try {
      await this.db.insert(brands).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        name: payload.name.replace(/\s+/g, " "),
        nameKey: key,
        manufacturer: payload.manufacturer ?? null,
        website: payload.website ?? null,
        logoUrl: payload.logoUrl ?? null,
        active: payload.active ?? true,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
    } catch (error) {
      throw this.duplicate(error, "This brand is already there.") ?? error;
    }
    await this.record(tenant, business.id, "brand.created", "brand", id, { name: payload.name });
    return this.presentBrand(await requireBrand(this.db, tenant, business.id, id));
  }

  async updateBrand(tenant: TenantContext, id: string, raw: unknown) {
    const payload = parse(brandWriteSchema.partial(), raw, "Check the brand.");
    const business = await requireBusiness(this.db, tenant);
    const existing = await requireBrand(this.db, tenant, business.id, id);
    try {
      await this.db
        .update(brands)
        .set({
          ...(payload.name !== undefined ? { name: payload.name.replace(/\s+/g, " "), nameKey: nameKey(payload.name) } : {}),
          ...(payload.manufacturer !== undefined ? { manufacturer: payload.manufacturer } : {}),
          ...(payload.website !== undefined ? { website: payload.website } : {}),
          ...(payload.logoUrl !== undefined ? { logoUrl: payload.logoUrl } : {}),
          ...(payload.active !== undefined ? { active: payload.active } : {}),
          updatedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(and(eq(brands.tenantId, tenant.tenantId), eq(brands.id, id)));
    } catch (error) {
      throw this.duplicate(error, "Another brand already has this name.") ?? error;
    }
    await this.record(tenant, business.id, "brand.updated", "brand", id, { from: { name: existing.name, active: existing.active }, to: payload });
    return this.presentBrand(await requireBrand(this.db, tenant, business.id, id));
  }

  private presentBrand(row: typeof brands.$inferSelect) {
    return { id: row.id, name: row.name, manufacturer: row.manufacturer, website: row.website, logoUrl: row.logoUrl, active: row.active };
  }

  // Items

  /** Items with their variants and this shop's stock. Search covers names, every code, brand and category. */
  async items(tenant: TenantContext, query: { q?: string; categoryId?: string; brandId?: string; type?: string; page?: number }) {
    const business = await requireBusiness(this.db, tenant);
    const page = Math.max(1, query.page ?? 1);
    const filters: SQL[] = [eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.businessId, business.id), isNull(catalogItems.archivedAt)];
    if (query.categoryId) filters.push(inArray(catalogItems.categoryId, await categoryAndBelow(this.db, tenant.tenantId, business.id, query.categoryId)));
    if (query.brandId) filters.push(eq(catalogItems.brandId, query.brandId));
    if (query.type && ["physical", "service", "digital", "non_stock"].includes(query.type)) filters.push(eq(catalogItems.itemType, query.type as "physical"));
    const needle = query.q?.trim();
    if (needle) {
      const code = needle.toLowerCase();
      const match = or(
        ilike(catalogItems.name, like(needle)),
        sql`${catalogItems.brandId} IN (SELECT id FROM brands WHERE tenant_id = ${tenant.tenantId} AND business_id = ${business.id} AND name ILIKE ${like(needle)})`,
        sql`${catalogItems.categoryId} IN (SELECT id FROM categories WHERE tenant_id = ${tenant.tenantId} AND business_id = ${business.id} AND name ILIKE ${like(needle)})`,
        sql`${catalogItems.id} IN (SELECT catalog_item_id FROM products WHERE tenant_id = ${tenant.tenantId} AND business_id = ${business.id} AND archived_at IS NULL AND (name ILIKE ${like(needle)} OR barcode = ${needle} OR gtin = ${needle} OR lower(sku) = ${code} OR lower(mpn) = ${code} OR lower(reference) = ${code}))`,
      );
      if (match) filters.push(match);
    }
    const rows = await this.db
      .select({ item: catalogItems, brandName: brands.name, categoryName: categories.name })
      .from(catalogItems)
      .leftJoin(brands, and(eq(brands.tenantId, catalogItems.tenantId), eq(brands.id, catalogItems.brandId)))
      .leftJoin(categories, and(eq(categories.tenantId, catalogItems.tenantId), eq(categories.id, catalogItems.categoryId)))
      .where(and(...filters))
      .orderBy(asc(catalogItems.name), asc(catalogItems.id))
      .limit(PRODUCT_PAGE_SIZE + 1)
      .offset((page - 1) * PRODUCT_PAGE_SIZE);
    const visible = rows.slice(0, PRODUCT_PAGE_SIZE);
    const variants = await this.variantsOf(tenant, visible.map((row) => row.item.id));
    return {
      page,
      hasMore: rows.length > PRODUCT_PAGE_SIZE,
      items: visible.map((row) => this.presentItem(tenant, row.item, row.brandName, row.categoryName, variants.get(row.item.id) ?? [])),
    };
  }

  async item(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const item = await requireItem(this.db, tenant, business.id, id, { includeArchived: true });
    const brand = item.brandId ? await requireBrand(this.db, tenant, business.id, item.brandId) : null;
    const variants = await this.variantsOf(tenant, [item.id]);
    const presented = this.presentItem(tenant, item, brand?.name ?? null, null, variants.get(item.id) ?? []);
    // Each variant's attributes (ADR-060), such as Colour: Red, Size: M.
    const attributes = await this.attributes.valuesOf(this.db, tenant.tenantId, presented.variants.map((variant) => variant.id));
    return {
      ...presented,
      variants: presented.variants.map((variant) => ({ ...variant, attributes: attributes.get(variant.id) ?? [] })),
      categoryPath: await categoryPath(this.db, tenant.tenantId, business.id, item.categoryId),
      details: {
        description: item.description,
        taxable: item.taxable,
        taxCode: item.taxCode,
        pricesIncludeTax: item.pricesIncludeTax,
        durationMinutes: item.durationMinutes,
        commissionBasisPoints: item.commissionBasisPoints,
        onlineTitle: item.onlineTitle,
        shortDescription: item.shortDescription,
        slug: item.slug,
        seoTitle: item.seoTitle,
        seoDescription: item.seoDescription,
        onlineVisible: item.onlineVisible,
        itemCondition: item.itemCondition,
        weightGrams: item.weightGrams?.toString() ?? null,
        lengthMm: item.lengthMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        taxonomyCode: item.taxonomyCode,
      },
    };
  }

  /** A new item with one or more variants, all in one transaction. A simple item is one variant with no label. */
  async createItem(tenant: TenantContext, raw: unknown) {
    const payload = parse(catalogItemCreateSchema, raw, "Check the item.");
    const business = await requireBusiness(this.db, tenant);
    if (payload.id) {
      const [taken] = await this.db.select({ id: catalogItems.id, tenantId: catalogItems.tenantId }).from(catalogItems).where(eq(catalogItems.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.item(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const itemType = payload.itemType ?? "physical";
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const category = payload.categoryId ? await requireCategory(tx, tenant, business.id, payload.categoryId) : null;
      if (category && !category.active) throw new ApiError("CATEGORY_INACTIVE", `"${category.name}" is no longer in use. Choose another category.`, 422, [{ field: "categoryId", message: "Not in use." }]);
      const brand = payload.brandId ? await requireBrand(tx, tenant, business.id, payload.brandId) : null;
      await tx.insert(catalogItems).values({ id, tenantId: tenant.tenantId, businessId: business.id, ...this.itemValues(payload), itemType, categoryId: category?.id ?? null, brandId: brand?.id ?? null, createdBy: tenant.userId, updatedBy: tenant.userId });
      const single = payload.variants.length === 1 && !payload.variants[0]?.variantLabel;
      for (const variant of payload.variants) {
        // A simple item's only variant has no label; it is still created under this item.
        await this.products.createIn(tx, tenant, this.asProduct(variant, payload.name, id, itemType === "physical", category?.name ?? null, single));
      }
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "catalog_item.created", entityType: "catalog_item", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN", metadata: { name: payload.name, itemType, variants: payload.variants.length } },
        tx,
      );
    });
    return this.item(tenant, id);
  }

  async addVariant(tenant: TenantContext, itemId: string, raw: unknown) {
    const payload = parse(addVariantSchema, raw, "Check the variant.");
    const business = await requireBusiness(this.db, tenant);
    const item = await requireItem(this.db, tenant, business.id, itemId);
    await this.db.transaction(async (tx) => {
      // The first extra variant gives the item's only variant a label too, so the two can be told apart.
      const [only] = await tx
        .select({ id: products.id, variantLabel: products.variantLabel })
        .from(products)
        .where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, item.id), isNull(products.archivedAt)));
      if (only && !only.variantLabel && payload.firstLabel) {
        const label = payload.firstLabel;
        await tx.update(products).set({ variantLabel: label, name: variantName(item.name, label), updatedAt: new Date() }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, only.id)));
      }
      const { firstLabel: _first, ...variant } = payload;
      await this.products.createIn(tx, tenant, this.asProduct(variant, item.name, item.id, item.itemType === "physical", null));
    });
    return this.item(tenant, item.id);
  }

  async updateItem(tenant: TenantContext, id: string, raw: unknown) {
    const payload = parse(catalogItemUpdateSchema, raw, "Check the item.");
    const business = await requireBusiness(this.db, tenant);
    const existing = await requireItem(this.db, tenant, business.id, id);
    const category = payload.categoryId ? await requireCategory(this.db, tenant, business.id, payload.categoryId) : payload.categoryId === null ? null : undefined;
    if (category && !category.active && category.id !== existing.categoryId) throw new ApiError("CATEGORY_INACTIVE", `"${category.name}" is no longer in use. Choose another category.`, 422, [{ field: "categoryId", message: "Not in use." }]);
    if (payload.brandId) await requireBrand(this.db, tenant, business.id, payload.brandId);
    if (payload.itemType && payload.itemType !== existing.itemType) await this.assertTypeChange(tenant, existing, payload.itemType);
    await this.db.transaction(async (tx) => {
      await tx
        .update(catalogItems)
        .set({ ...this.itemValues(payload), ...(category !== undefined ? { categoryId: category?.id ?? null } : {}), ...(payload.brandId !== undefined ? { brandId: payload.brandId } : {}), updatedAt: new Date(), updatedBy: tenant.userId })
        .where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.id, id)));
      const variants = await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, id)));
      if (payload.name && payload.name !== existing.name) {
        for (const variant of variants) {
          await tx.update(products).set({ name: variantName(payload.name, variant.variantLabel), updatedAt: new Date(), updatedBy: tenant.userId }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, variant.id)));
        }
      }
      if (payload.itemType && payload.itemType !== existing.itemType) {
        await tx.update(products).set({ trackStock: payload.itemType === "physical", updatedAt: new Date() }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, id)));
      }
      if (category !== undefined) await copyCategoryToVariants(tx, tenant.tenantId, id, category?.name ?? null);
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "catalog_item.updated", entityType: "catalog_item", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN", metadata: { changes: payload } },
        tx,
      );
    });
    return this.item(tenant, id);
  }

  /** Stock already recorded stays with the item: a stocked item cannot become a service while it has movements. */
  private async assertTypeChange(tenant: TenantContext, item: typeof catalogItems.$inferSelect, next: string) {
    if (item.itemType !== "physical" || next === "physical") return;
    const [moved] = await this.db
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .innerJoin(products, and(eq(products.tenantId, stockMovements.tenantId), eq(products.id, stockMovements.productId)))
      .where(and(eq(stockMovements.tenantId, tenant.tenantId), eq(products.catalogItemId, item.id)))
      .limit(1);
    if (moved) throw new ApiError("ITEM_TYPE_LOCKED", "This item has stock records, so it stays a stocked item. Add a new item for the service.", 422, [{ field: "itemType", message: "Keep it stocked." }]);
  }

  async archiveItem(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = parse(catalogItemArchiveSchema, raw, "Check the reason.");
    const business = await requireBusiness(this.db, tenant);
    await requireItem(this.db, tenant, business.id, id);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(catalogItems).set({ archivedAt: now, updatedAt: now, updatedBy: tenant.userId }).where(and(eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.id, id)));
      // Variants are archived, never deleted: sales, stock and the books keep pointing at them.
      await tx.update(products).set({ archivedAt: now, updatedAt: now, updatedBy: tenant.userId }).where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, id), isNull(products.archivedAt)));
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "catalog_item.archived", entityType: "catalog_item", entityId: id, correlationId: tenant.correlationId, businessId: business.id, actorType: tenant.actorType ?? "HUMAN", metadata: { reason: reason ?? null } },
        tx,
      );
    });
    return { archived: true };
  }

  /** A variant as the product service takes it. */
  private asProduct(variant: ReturnType<typeof variantCreateSchema.parse>, itemName: string, itemId: string, trackStock: boolean, category: string | null, only = false) {
    const { variantLabel, ...rest } = variant;
    return {
      ...rest,
      name: variantName(itemName, variantLabel),
      catalogItemId: itemId,
      ...(variantLabel ? { variantLabel } : {}),
      trackStock,
      category,
      onlyVariant: only,
    };
  }

  private itemValues(payload: Partial<ReturnType<typeof catalogItemCreateSchema.parse>>) {
    const pick = <K extends keyof typeof payload>(key: K) => (payload[key] !== undefined ? { [key]: payload[key] } : {});
    return {
      ...(payload.name !== undefined ? { name: payload.name.replace(/\s+/g, " ") } : {}),
      ...pick("description"),
      ...pick("taxable"),
      ...pick("taxCode"),
      ...pick("pricesIncludeTax"),
      ...pick("durationMinutes"),
      ...pick("commissionBasisPoints"),
      ...pick("onlineTitle"),
      ...pick("shortDescription"),
      ...pick("slug"),
      ...pick("seoTitle"),
      ...pick("seoDescription"),
      ...pick("onlineVisible"),
      ...pick("itemCondition"),
      ...(payload.weightGrams !== undefined ? { weightGrams: payload.weightGrams === null ? null : BigInt(payload.weightGrams) } : {}),
      ...pick("lengthMm"),
      ...pick("widthMm"),
      ...pick("heightMm"),
      ...pick("taxonomyCode"),
      ...(payload.itemType !== undefined ? { itemType: payload.itemType } : {}),
    } as Partial<typeof catalogItems.$inferInsert> & { name: string };
  }

  private async variantsOf(tenant: TenantContext, itemIds: string[]) {
    const map = new Map<string, { product: typeof products.$inferSelect; quantity: bigint | null }[]>();
    if (itemIds.length === 0) return map;
    const rows = await this.db
      .select({ product: products, quantity: stockBalances.quantity })
      .from(products)
      .leftJoin(stockBalances, and(eq(stockBalances.tenantId, products.tenantId), eq(stockBalances.productId, products.id), eq(stockBalances.branchId, tenant.branchId ?? "00000000-0000-0000-0000-000000000000")))
      .where(and(eq(products.tenantId, tenant.tenantId), inArray(products.catalogItemId, itemIds), isNull(products.archivedAt)))
      .orderBy(asc(products.name));
    for (const row of rows) map.set(row.product.catalogItemId, [...(map.get(row.product.catalogItemId) ?? []), row]);
    return map;
  }

  private presentItem(tenant: TenantContext, item: typeof catalogItems.$inferSelect, brandName: string | null, categoryName: string | null, variants: { product: typeof products.$inferSelect; quantity: bigint | null }[]) {
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return {
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      categoryId: item.categoryId,
      categoryName,
      brandId: item.brandId,
      brandName,
      archived: item.archivedAt !== null,
      variants: variants.map(({ product, quantity }) => ({
        id: product.id,
        name: product.name,
        variantLabel: product.variantLabel,
        sku: product.sku,
        barcode: product.barcode,
        gtin: product.gtin,
        baseUnit: product.baseUnit,
        priceMinor: product.priceMinor?.toString() ?? null,
        ...(seeCost ? { defaultCostMinor: product.defaultCostMinor?.toString() ?? null } : {}),
        trackStock: product.trackStock,
        quantity: product.trackStock ? (quantity ?? 0n).toString() : null,
      })),
    };
  }

  private duplicate(error: unknown, message: string) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    return code === "23505" ? new ApiError("DUPLICATE", message, 409) : null;
  }

  private async record(tenant: TenantContext, businessId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record({ tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType, entityId, correlationId: tenant.correlationId, businessId, actorType: tenant.actorType ?? "HUMAN", metadata });
  }
}
