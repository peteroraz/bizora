import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { branches, businesses, productUnits, products } from "../../db/schema.js";
import { and, eq, inArray, isNull } from "drizzle-orm";

export type BusinessRow = typeof businesses.$inferSelect;
export type BranchRow = typeof branches.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type ProductUnitRow = typeof productUnits.$inferSelect;

export async function requireBusiness(executor: DbExecutor, tenant: TenantContext): Promise<BusinessRow> {
  if (!tenant.businessId) throw new ApiError("BUSINESS_REQUIRED", "Choose a business first.", 400);
  if (tenant.membershipBusinessId && tenant.membershipBusinessId !== tenant.businessId) {
    throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
  }
  const [business] = await executor
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, tenant.businessId), eq(businesses.tenantId, tenant.tenantId)))
    .limit(1);
  if (!business) throw new ApiError("BUSINESS_NOT_FOUND", "Business was not found.", 404);
  return business;
}

/** The shop to act on. Branch-scoped staff always act on their own shop. */
export async function resolveBranch(executor: DbExecutor, tenant: TenantContext, businessId: string, requested?: string) {
  const branchId = tenant.membershipBranchId ?? requested ?? tenant.branchId;
  if (!branchId) throw new ApiError("BRANCH_REQUIRED", "Choose a shop first.", 400);
  if (tenant.membershipBranchId && branchId !== tenant.membershipBranchId) {
    throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
  }
  return findBranch(executor, tenant, businessId, branchId);
}

/** Any shop of the same business (for example the shop stock is moved to). */
export async function findBranch(executor: DbExecutor, tenant: TenantContext, businessId: string, branchId: string) {
  const [branch] = await executor
    .select()
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, businessId)))
    .limit(1);
  if (!branch) throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
  return branch;
}

export async function requireProduct(
  executor: DbExecutor,
  tenant: TenantContext,
  businessId: string,
  productId: string,
  options: { includeArchived?: boolean } = {},
) {
  const filters = [eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), eq(products.id, productId)];
  if (!options.includeArchived) filters.push(isNull(products.archivedAt));
  const [product] = await executor.select().from(products).where(and(...filters)).limit(1);
  if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "Product was not found.", 404);
  return product;
}

export async function productUnitsFor(executor: DbExecutor, tenantId: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, ProductUnitRow[]>();
  const rows = await executor
    .select()
    .from(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), inArray(productUnits.productId, productIds)));
  const map = new Map<string, ProductUnitRow[]>();
  for (const row of rows) map.set(row.productId, [...(map.get(row.productId) ?? []), row]);
  return map;
}

/** Thousandths of the base unit in one of `unit`: 1000 for the base unit, the pack size for packs. */
export function unitFactor(product: ProductRow, units: ProductUnitRow[], unit: string): bigint {
  if (unit === product.baseUnit) return 1000n;
  const pack = units.find((item) => item.unitCode === unit);
  if (!pack) throw new ApiError("UNIT_NOT_FOUND", `This product is not counted in ${unit}.`, 422, [{ field: "unit", message: "Choose one of this product's units." }]);
  return pack.baseQuantity;
}
