import { Inject, Injectable } from "@nestjs/common";
import {
  customerPriceListSchema,
  parseQuantity,
  Permission,
  priceListPricesSchema,
  priceListWriteSchema,
  quantityToString,
  supplierProductWriteSchema,
} from "@bizora/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { customers, priceListPrices, priceLists, productUnits, products, supplierProducts, suppliers } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { localDate } from "../../common/zoned-day.js";
import { findBranch, requireBusiness, resolveBranch, type BusinessRow } from "../inventory/inventory-scope.js";
import { choosePriceList } from "./price-selection.js";
import { rowsOf } from "./rows.js";

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const text = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString());

/**
 * Price lists and the suppliers of each product (ADR-048). A product's own price stays its everyday price; a list
 * holds other prices (wholesale, a big buyer's) by unit, from a minimum quantity and for a while. Every change is
 * audited; prices already on sales never change.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // Price lists ------------------------------------------------------------------------------------------------

  async lists(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select({ list: priceLists, prices: sql<number>`(SELECT count(*)::int FROM price_list_prices p WHERE p.tenant_id = ${priceLists.tenantId} AND p.price_list_id = ${priceLists.id})` })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenant.tenantId), eq(priceLists.businessId, business.id)))
      .orderBy(asc(priceLists.position), asc(priceLists.nameKey));
    // Staff selling at the counter see only what they may use; managers see every list.
    const manages = tenant.permissions.includes(Permission.PRICING_LISTS_MANAGE);
    const discounts = tenant.permissions.includes(Permission.SALES_DISCOUNT);
    return {
      lists: rows
        .filter(({ list }) => manages || (list.active && (discounts || list.staffCanChoose)))
        .map(({ list, prices }) => this.presentList(list, Number(prices))),
    };
  }

  async createList(tenant: TenantContext, raw: unknown) {
    const payload = priceListWriteSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const values = await this.listValues(tx, tenant, business, payload);
      const id = newId();
      await this.assertNameFree(tx, tenant, business.id, values.nameKey);
      await tx.insert(priceLists).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        name: values.name,
        nameKey: values.nameKey,
        currencyCode: values.currencyCode,
        branchId: values.branchId ?? null,
        active: payload.active ?? true,
        staffCanChoose: payload.staffCanChoose ?? false,
        position: payload.position ?? 0,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await this.record(tx, tenant, business.id, "pricing.list.created", "price_list", id, { name: values.name });
      return this.presentList((await this.requireList(tx, tenant, business.id, id)), 0);
    });
  }

  async updateList(tenant: TenantContext, id: string, raw: unknown) {
    const payload = priceListWriteSchema.partial().parse(raw);
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const existing = await this.requireList(tx, tenant, business.id, id);
      const changes: Partial<typeof priceLists.$inferInsert> = { updatedAt: new Date(), updatedBy: tenant.userId };
      if (payload.name !== undefined) {
        const key = nameKey(payload.name);
        if (key !== existing.nameKey) await this.assertNameFree(tx, tenant, business.id, key);
        changes.name = payload.name.trim().replace(/\s+/g, " ");
        changes.nameKey = key;
      }
      if (payload.branchId !== undefined) {
        if (payload.branchId) await findBranch(tx, tenant, business.id, payload.branchId);
        changes.branchId = payload.branchId ?? null;
      }
      if (payload.currencyCode !== undefined) changes.currencyCode = this.currency(business, payload.currencyCode);
      if (payload.active !== undefined) changes.active = payload.active;
      if (payload.staffCanChoose !== undefined) changes.staffCanChoose = payload.staffCanChoose;
      if (payload.position !== undefined) changes.position = payload.position;
      await tx.update(priceLists).set(changes).where(and(eq(priceLists.tenantId, tenant.tenantId), eq(priceLists.id, existing.id)));
      await this.record(tx, tenant, business.id, "pricing.list.updated", "price_list", id, {
        before: { name: existing.name, active: existing.active, branchId: existing.branchId, staffCanChoose: existing.staffCanChoose },
        after: { name: changes.name ?? existing.name, active: changes.active ?? existing.active, branchId: changes.branchId === undefined ? existing.branchId : changes.branchId, staffCanChoose: changes.staffCanChoose ?? existing.staffCanChoose },
      });
      return this.presentList(await this.requireList(tx, tenant, business.id, id), 0);
    });
  }

  async prices(tenant: TenantContext, id: string, query: { productId?: string } = {}) {
    const business = await requireBusiness(this.db, tenant);
    const list = await this.requireList(this.db, tenant, business.id, id);
    const filters = [eq(priceListPrices.tenantId, tenant.tenantId), eq(priceListPrices.priceListId, list.id)];
    if (query.productId && /^[0-9a-f-]{36}$/i.test(query.productId)) filters.push(eq(priceListPrices.productId, query.productId));
    const rows = await this.db
      .select({ price: priceListPrices, productName: products.name, baseUnit: products.baseUnit, everyday: products.priceMinor })
      .from(priceListPrices)
      .innerJoin(products, and(eq(products.tenantId, priceListPrices.tenantId), eq(products.id, priceListPrices.productId)))
      .where(and(...filters))
      .orderBy(asc(products.name), asc(priceListPrices.unitCode), asc(priceListPrices.minQuantity))
      .limit(2000);
    return {
      list: this.presentList(list, rows.length),
      prices: rows.map(({ price, productName, baseUnit, everyday }) => ({
        ...this.presentPrice(price),
        productName,
        everydayPriceMinor: price.unitCode === baseUnit ? text(everyday) : null,
      })),
    };
  }

  /** Adds or changes prices on a list; the same product, unit, minimum and start date is one price. */
  async setPrices(tenant: TenantContext, id: string, raw: unknown) {
    const payload = priceListPricesSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const list = await this.requireList(tx, tenant, business.id, id);
      const productIds = [...new Set(payload.prices.map((price) => price.productId))];
      const found = await tx
        .select({ id: products.id, baseUnit: products.baseUnit, name: products.name })
        .from(products)
        .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), inArray(products.id, productIds)));
      const byId = new Map(found.map((product) => [product.id, product]));
      const packs = await tx
        .select({ productId: productUnits.productId, unitCode: productUnits.unitCode })
        .from(productUnits)
        .where(and(eq(productUnits.tenantId, tenant.tenantId), inArray(productUnits.productId, productIds)));
      const changed: string[] = [];
      for (const [index, price] of payload.prices.entries()) {
        const product = byId.get(price.productId);
        if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "A product in these prices was not found.", 404, [{ field: `prices.${index}.productId`, message: "Not found." }]);
        const unitKnown = price.unitCode === product.baseUnit || packs.some((pack) => pack.productId === product.id && pack.unitCode === price.unitCode);
        if (!unitKnown) {
          throw new ApiError("UNIT_NOT_FOUND", `${product.name} is not sold by the ${price.unitCode}. Add the pack to the product first.`, 400, [{ field: `prices.${index}.unitCode`, message: "Not a unit of this product." }]);
        }
        const minQuantity = price.minQuantity ? (parseQuantity(price.minQuantity) as bigint) : 1000n;
        const from = price.effectiveFrom ?? null;
        const [existing] = await tx
          .select()
          .from(priceListPrices)
          .where(
            and(
              eq(priceListPrices.tenantId, tenant.tenantId),
              eq(priceListPrices.priceListId, list.id),
              eq(priceListPrices.productId, product.id),
              eq(priceListPrices.unitCode, price.unitCode),
              eq(priceListPrices.minQuantity, minQuantity),
              from === null ? sql`${priceListPrices.effectiveFrom} IS NULL` : eq(priceListPrices.effectiveFrom, from),
            ),
          )
          .limit(1);
        const values = { priceMinor: BigInt(price.priceMinor), effectiveTo: price.effectiveTo ?? null, updatedAt: new Date(), updatedBy: tenant.userId };
        if (existing) {
          await tx.update(priceListPrices).set(values).where(eq(priceListPrices.id, existing.id));
          changed.push(`${product.name} ${price.unitCode}: ${existing.priceMinor} → ${values.priceMinor}`);
        } else {
          await tx.insert(priceListPrices).values({
            id: newId(),
            tenantId: tenant.tenantId,
            businessId: business.id,
            priceListId: list.id,
            productId: product.id,
            unitCode: price.unitCode,
            minQuantity,
            effectiveFrom: from,
            ...values,
          });
          changed.push(`${product.name} ${price.unitCode}: ${values.priceMinor}`);
        }
      }
      await this.record(tx, tenant, business.id, "pricing.prices.set", "price_list", list.id, { list: list.name, changes: changed.slice(0, 100) });
      return { saved: payload.prices.length };
    });
  }

  async removePrice(tenant: TenantContext, id: string, priceId: string) {
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const list = await this.requireList(tx, tenant, business.id, id);
      const [price] = await tx
        .select()
        .from(priceListPrices)
        .where(and(eq(priceListPrices.tenantId, tenant.tenantId), eq(priceListPrices.priceListId, list.id), eq(priceListPrices.id, priceId)))
        .limit(1);
      if (!price) throw new ApiError("PRICE_NOT_FOUND", "That price was not found.", 404);
      await tx.delete(priceListPrices).where(eq(priceListPrices.id, price.id));
      await this.record(tx, tenant, business.id, "pricing.price.removed", "price_list", list.id, { price: this.presentPrice(price) });
      return { removed: true };
    });
  }

  /**
   * The prices a sale would use today, for the sale screen: the chosen list, else the customer's (ADR-048). The same
   * rules as the sale itself, so the screen shows what the sale will cost. No costs, only selling prices.
   */
  async forSale(tenant: TenantContext, query: { customerId?: string; priceListId?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, query.branchId);
    const uuid = (value?: string) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
    const customerId = uuid(query.customerId);
    let customerListId: string | null = null;
    if (customerId) {
      const [customer] = await this.db
        .select({ priceListId: customers.priceListId })
        .from(customers)
        .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), eq(customers.id, customerId)))
        .limit(1);
      if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404);
      customerListId = customer.priceListId;
    }
    const list = await choosePriceList(this.db, tenant, {
      businessId: business.id,
      branchId: branch.id,
      currencyCode: business.baseCurrencyCode,
      chosenId: uuid(query.priceListId),
      customerListId,
    });
    if (!list) return { priceList: null, prices: [] };
    const today = localDate(new Date(), business.timezone);
    const rows = rowsOf<{ product_id: string; unit_code: string; min_quantity: string; price_minor: string }>(
      await this.db.execute(sql`
        SELECT DISTINCT ON (product_id, unit_code, min_quantity) product_id, unit_code, min_quantity::text, price_minor::text
        FROM price_list_prices
        WHERE tenant_id = ${tenant.tenantId} AND price_list_id = ${list.id}
          AND (effective_from IS NULL OR effective_from <= ${today}::date)
          AND (effective_to IS NULL OR effective_to >= ${today}::date)
        ORDER BY product_id, unit_code, min_quantity DESC, effective_from DESC NULLS LAST
        LIMIT 20000`),
    );
    return {
      priceList: list,
      prices: rows.map((row) => ({ productId: row.product_id, unitCode: row.unit_code, minQuantity: quantityToString(BigInt(row.min_quantity)), priceMinor: row.price_minor })),
    };
  }

  /** Every list's prices for one product, for the product page. */
  async productPrices(tenant: TenantContext, productId: string) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select({ price: priceListPrices, listName: priceLists.name, active: priceLists.active })
      .from(priceListPrices)
      .innerJoin(priceLists, and(eq(priceLists.tenantId, priceListPrices.tenantId), eq(priceLists.id, priceListPrices.priceListId)))
      .where(and(eq(priceListPrices.tenantId, tenant.tenantId), eq(priceListPrices.businessId, business.id), eq(priceListPrices.productId, productId)))
      .orderBy(asc(priceLists.position), asc(priceLists.nameKey), asc(priceListPrices.unitCode), asc(priceListPrices.minQuantity));
    return { prices: rows.map(({ price, listName, active }) => ({ ...this.presentPrice(price), listName, listActive: active })) };
  }

  async setCustomerList(tenant: TenantContext, customerId: string, raw: unknown) {
    const payload = customerPriceListSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const [customer] = await tx
        .select({ id: customers.id, name: customers.name, priceListId: customers.priceListId })
        .from(customers)
        .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), eq(customers.id, customerId)))
        .limit(1);
      if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404);
      const list = payload.priceListId ? await this.requireList(tx, tenant, business.id, payload.priceListId) : null;
      await tx.update(customers).set({ priceListId: list?.id ?? null, updatedAt: new Date() }).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.id, customer.id)));
      await this.record(tx, tenant, business.id, "customer.price_list.set", "customer", customer.id, { before: customer.priceListId, after: list?.id ?? null, list: list?.name ?? null });
      return { customerId: customer.id, priceList: list ? { id: list.id, name: list.name } : null };
    });
  }

  // Suppliers of a product -------------------------------------------------------------------------------------

  async productSuppliers(tenant: TenantContext, productId: string) {
    const business = await requireBusiness(this.db, tenant);
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const [product] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), eq(products.id, productId)))
      .limit(1);
    if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.", 404);
    const rows = await this.db
      .select({ line: supplierProducts, supplierName: suppliers.name })
      .from(supplierProducts)
      .innerJoin(suppliers, and(eq(suppliers.tenantId, supplierProducts.tenantId), eq(suppliers.id, supplierProducts.supplierId)))
      .where(and(eq(supplierProducts.tenantId, tenant.tenantId), eq(supplierProducts.businessId, business.id), eq(supplierProducts.productId, product.id)))
      .orderBy(desc(supplierProducts.preferred), sql`${supplierProducts.lastReceivedAt} DESC NULLS LAST`, asc(suppliers.name));
    return {
      ...(seeCost
        ? { lastPurchaseCostMinor: text(product.lastPurchaseCostMinor), lastLandedCostMinor: text(product.lastLandedCostMinor) }
        : {}),
      lastPurchasedAt: product.lastPurchasedAt,
      suppliers: rows.map(({ line, supplierName }) => ({
        supplierId: line.supplierId,
        supplierName,
        supplierSku: line.supplierSku,
        preferred: line.preferred,
        leadTimeDays: line.leadTimeDays,
        minimumOrderQuantity: line.minimumOrderQuantity === null ? null : quantityToString(line.minimumOrderQuantity),
        purchaseUnit: line.purchaseUnit,
        currency: line.currencyCode.trim(),
        lastReceivedAt: line.lastReceivedAt,
        ...(seeCost ? { lastCostMinor: text(line.lastCostMinor) } : {}),
      })),
    };
  }

  /** Adds a supplier to a product, or changes their code and terms. Only one supplier is preferred. */
  async setSupplierProduct(tenant: TenantContext, supplierId: string, raw: unknown) {
    const payload = supplierProductWriteSchema.parse(raw);
    if (payload.lastCostMinor && !tenant.permissions.includes(Permission.PRICES_COST_READ)) {
      throw new ApiError("FORBIDDEN", "Only someone who can see cost prices can set them.", 403, [{ field: "lastCostMinor", message: "Leave cost empty." }]);
    }
    const productId = await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const supplier = await this.requireSupplier(tx, tenant, business.id, supplierId);
      const [product] = await tx
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), eq(products.id, payload.productId)))
        .limit(1);
      if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.", 404, [{ field: "productId", message: "Not found." }]);
      if (payload.preferred) {
        await tx
          .update(supplierProducts)
          .set({ preferred: false, updatedAt: new Date() })
          .where(and(eq(supplierProducts.tenantId, tenant.tenantId), eq(supplierProducts.productId, product.id), eq(supplierProducts.preferred, true)));
      }
      const values = {
        ...(payload.supplierSku !== undefined ? { supplierSku: payload.supplierSku?.trim() || null } : {}),
        ...(payload.lastCostMinor !== undefined ? { lastCostMinor: payload.lastCostMinor === null ? null : BigInt(payload.lastCostMinor) } : {}),
        ...(payload.preferred !== undefined ? { preferred: payload.preferred } : {}),
        ...(payload.leadTimeDays !== undefined ? { leadTimeDays: payload.leadTimeDays } : {}),
        ...(payload.minimumOrderQuantity !== undefined ? { minimumOrderQuantity: payload.minimumOrderQuantity === null ? null : parseQuantity(payload.minimumOrderQuantity) } : {}),
        ...(payload.purchaseUnit !== undefined ? { purchaseUnit: payload.purchaseUnit } : {}),
        updatedAt: new Date(),
        updatedBy: tenant.userId,
      };
      await tx
        .insert(supplierProducts)
        .values({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, supplierId: supplier.id, productId: product.id, currencyCode: business.baseCurrencyCode.trim(), ...values })
        .onConflictDoUpdate({ target: [supplierProducts.tenantId, supplierProducts.supplierId, supplierProducts.productId], set: values });
      await this.record(tx, tenant, business.id, "supplier.product.set", "supplier", supplier.id, {
        product: product.name,
        supplierSku: values.supplierSku ?? undefined,
        preferred: values.preferred ?? undefined,
      });
      return product.id;
    });
    return this.productSuppliers(tenant, productId);
  }

  async removeSupplierProduct(tenant: TenantContext, supplierId: string, productId: string) {
    return this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const supplier = await this.requireSupplier(tx, tenant, business.id, supplierId);
      const removed = await tx
        .delete(supplierProducts)
        .where(and(eq(supplierProducts.tenantId, tenant.tenantId), eq(supplierProducts.businessId, business.id), eq(supplierProducts.supplierId, supplier.id), eq(supplierProducts.productId, productId)))
        .returning({ id: supplierProducts.id });
      if (removed.length === 0) throw new ApiError("NOT_FOUND", "This supplier is not listed for the product.", 404);
      await this.record(tx, tenant, business.id, "supplier.product.removed", "supplier", supplier.id, { productId });
      return { removed: true };
    });
  }

  // Helpers ----------------------------------------------------------------------------------------------------

  private async listValues(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, payload: ReturnType<typeof priceListWriteSchema.parse>) {
    if (payload.branchId) await findBranch(tx, tenant, business.id, payload.branchId);
    return {
      name: payload.name.trim().replace(/\s+/g, " "),
      nameKey: nameKey(payload.name),
      currencyCode: this.currency(business, payload.currencyCode),
      branchId: payload.branchId ?? null,
    };
  }

  /** Lists are in the business's currency for now; sales are in one currency (ADR-048). */
  private currency(business: BusinessRow, code: string | undefined) {
    const base = business.baseCurrencyCode.trim();
    if (code && code !== base) {
      throw new ApiError("CURRENCY_NOT_USED", `Price lists use the business's currency, ${base}.`, 400, [{ field: "currencyCode", message: `Use ${base}.` }]);
    }
    return base;
  }

  private async assertNameFree(tx: DbExecutor, tenant: TenantContext, businessId: string, key: string) {
    const [taken] = await tx
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenant.tenantId), eq(priceLists.businessId, businessId), eq(priceLists.nameKey, key)))
      .limit(1);
    if (taken) throw new ApiError("DUPLICATE_NAME", "There is already a price list with this name.", 409, [{ field: "name", message: "Already used." }]);
  }

  private async requireList(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [list] = await executor
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenant.tenantId), eq(priceLists.businessId, businessId), eq(priceLists.id, id)))
      .limit(1);
    if (!list) throw new ApiError("PRICE_LIST_NOT_FOUND", "That price list was not found.", 404, [{ field: "priceListId", message: "Not found." }]);
    return list;
  }

  private async requireSupplier(tx: DbExecutor, tenant: TenantContext, businessId: string, supplierId: string) {
    const [supplier] = await tx
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenant.tenantId), eq(suppliers.businessId, businessId), eq(suppliers.id, supplierId)))
      .limit(1);
    if (!supplier) throw new ApiError("SUPPLIER_NOT_FOUND", "Supplier not found.", 404);
    return supplier;
  }

  private presentList(list: typeof priceLists.$inferSelect, prices: number) {
    return {
      id: list.id,
      name: list.name,
      currency: list.currencyCode.trim(),
      branchId: list.branchId,
      active: list.active,
      staffCanChoose: list.staffCanChoose,
      position: list.position,
      prices,
      updatedAt: list.updatedAt,
    };
  }

  private presentPrice(price: typeof priceListPrices.$inferSelect) {
    return {
      id: price.id,
      priceListId: price.priceListId,
      productId: price.productId,
      unitCode: price.unitCode,
      minQuantity: quantityToString(price.minQuantity),
      priceMinor: price.priceMinor.toString(),
      effectiveFrom: price.effectiveFrom,
      effectiveTo: price.effectiveTo,
    };
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType,
        entityId,
        correlationId: tenant.correlationId,
        businessId,
        metadata,
        actorType: tenant.actorType ?? "HUMAN",
      },
      tx,
    );
  }
}
