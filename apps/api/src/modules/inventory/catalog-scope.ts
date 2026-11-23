import { CATEGORY_MAX_DEPTH, nameKey } from "@bizora/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { brands, catalogItems, categories, products } from "../../db/schema.js";

export type CategoryRow = typeof categories.$inferSelect;
export type BrandRow = typeof brands.$inferSelect;
export type CatalogItemRow = typeof catalogItems.$inferSelect;

/** A category of this business, or 404. The tenant and business come from the session, never from the request. */
export async function requireCategory(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
  const [category] = await executor
    .select()
    .from(categories)
    .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.businessId, businessId), eq(categories.id, id)))
    .limit(1);
  if (!category) throw new ApiError("CATEGORY_NOT_FOUND", "This category was not found. Choose another one.", 404, [{ field: "categoryId", message: "Not found." }]);
  return category;
}

export async function requireBrand(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
  const [brand] = await executor
    .select()
    .from(brands)
    .where(and(eq(brands.tenantId, tenant.tenantId), eq(brands.businessId, businessId), eq(brands.id, id)))
    .limit(1);
  if (!brand) throw new ApiError("BRAND_NOT_FOUND", "This brand was not found. Choose another one.", 404, [{ field: "brandId", message: "Not found." }]);
  return brand;
}

export async function requireItem(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string, options: { includeArchived?: boolean } = {}) {
  const filters = [eq(catalogItems.tenantId, tenant.tenantId), eq(catalogItems.businessId, businessId), eq(catalogItems.id, id)];
  if (!options.includeArchived) filters.push(isNull(catalogItems.archivedAt));
  const [item] = await executor.select().from(catalogItems).where(and(...filters)).limit(1);
  if (!item) throw new ApiError("ITEM_NOT_FOUND", "This item was not found.", 404);
  return item;
}

/**
 * The category for an item: by ID (must be this business's and in use), or by the name typed in the older product
 * form and imports, found at the top level or made there. Returns null for no category.
 */
export async function resolveCategory(
  executor: DbExecutor,
  tenant: TenantContext,
  businessId: string,
  input: { categoryId?: string | null | undefined; categoryText?: string | null | undefined },
): Promise<CategoryRow | null> {
  if (input.categoryId) {
    const category = await requireCategory(executor, tenant, businessId, input.categoryId);
    if (!category.active) throw new ApiError("CATEGORY_INACTIVE", `"${category.name}" is no longer in use. Choose another category.`, 422, [{ field: "categoryId", message: "Not in use." }]);
    return category;
  }
  const text = input.categoryText?.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const key = nameKey(text).slice(0, 60);
  const [found] = await executor
    .select()
    .from(categories)
    .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.businessId, businessId), isNull(categories.parentId), eq(categories.nameKey, key)))
    .limit(1);
  if (found) return found;
  const [made] = await executor
    .insert(categories)
    .values({ id: newId(), tenantId: tenant.tenantId, businessId, name: text.slice(0, 60), nameKey: key, createdBy: tenant.userId, updatedBy: tenant.userId })
    .onConflictDoNothing()
    .returning();
  if (made) return made;
  // Made by another request at the same moment.
  const [raced] = await executor
    .select()
    .from(categories)
    .where(and(eq(categories.tenantId, tenant.tenantId), eq(categories.businessId, businessId), isNull(categories.parentId), eq(categories.nameKey, key)))
    .limit(1);
  return raced ?? null;
}

/** "Food › Drinks › Water", walking up the parents, for lists and receipts. */
export async function categoryPath(executor: DbExecutor, tenantId: string, businessId: string, categoryId: string | null) {
  if (!categoryId) return null;
  const rows = await executor
    .select({ id: categories.id, parentId: categories.parentId, name: categories.name })
    .from(categories)
    .where(and(eq(categories.tenantId, tenantId), eq(categories.businessId, businessId)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const names: string[] = [];
  let at = byId.get(categoryId);
  for (let depth = 0; at && depth <= CATEGORY_MAX_DEPTH; depth += 1) {
    names.unshift(at.name);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return names.join(" › ");
}

/** The category and every category under it, for "show everything in Drinks". */
export async function categoryAndBelow(executor: DbExecutor, tenantId: string, businessId: string, categoryId: string) {
  const rows = await executor
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.tenantId, tenantId), eq(categories.businessId, businessId)));
  const ids = new Set([categoryId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

/** Keeps the old free-text `products.category` the same as the item's category name, for screens and phones that read it. */
export async function copyCategoryToVariants(executor: DbExecutor, tenantId: string, itemId: string, categoryName: string | null) {
  await executor
    .update(products)
    .set({ category: categoryName ? categoryName.slice(0, 60) : null, updatedAt: new Date() })
    .where(and(eq(products.tenantId, tenantId), eq(products.catalogItemId, itemId), sql`${products.category} IS DISTINCT FROM ${categoryName}`));
}
