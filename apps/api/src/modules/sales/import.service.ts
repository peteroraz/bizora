import { Inject, Injectable } from "@nestjs/common";
import {
  IMPORT_MAX_ROWS,
  currencyDigits,
  normalizePhoneToE164,
  parseMoneyInput,
  parseQuantity,
  parseTraderDate,
  paidFromText,
  paymentFromText,
  Permission,
  gtinSchema,
  nameKey,
  productImportSchema,
  salesImportSchema,
  skuSchema,
  variantName,
  STOCK_ADD_REASONS,
  STOCK_REMOVE_REASONS,
  parseCountQuantity,
  quantityToString,
  stockAdjustSchema,
  stockChangeImportSchema,
  stockCountImportSchema,
  stockCountSchema,
  stockInImportSchema,
  stockMoveImportSchema,
  stockReceiveSchema,
  stockTransferSchema,
  unitFromText,
  type ImportRowResult,
} from "@bizora/contracts";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { branches, customers, products, stockBalances } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { productUnitsFor, requireBusiness, resolveBranch, type ProductRow, type ProductUnitRow } from "../inventory/inventory-scope.js";
import { AuditService } from "../audit/audit.service.js";
import { CatalogService } from "../inventory/catalog.service.js";
import { brandFromName, CATEGORY_PATH_MAX, categoryFromPath, categoryLevels, itemByName, priceListsByName, setListPrice, setSupplierCode, yesNo } from "../inventory/product-file.js";
import { ProductService } from "../inventory/product.service.js";
import { StockService } from "../inventory/stock.service.js";
import { SaleService } from "./sale.service.js";

const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
const decimal = (thousandths: bigint) => {
  const whole = thousandths / 1000n;
  const fraction = (thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

/**
 * CSV imports for products and sales (ADR-015). Every import is checked first (dry run): each row says what will
 * happen or exactly what is wrong. Nothing is saved while any row has a problem; the person fixes or removes those
 * rows on the review screen and saves again. Photo and voice capture (ADR-018) fill the same review screen; such
 * rows arrive with source "capture" once a person has checked them.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(ProductService) private readonly productService: ProductService,
    @Inject(SaleService) private readonly sales: SaleService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  async products(tenant: TenantContext, raw: unknown) {
    const payload = productImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const business = await requireBusiness(this.db, tenant);
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const managesLists = tenant.permissions.includes(Permission.PRICING_LISTS_MANAGE);
    const managesSuppliers = tenant.permissions.includes(Permission.PURCHASES_MANAGE);
    const existing = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)));
    const byName = new Map(existing.map((product) => [product.name.trim().toLowerCase(), product]));
    const units = await productUnitsFor(this.db, tenant.tenantId, existing.map((product) => product.id));
    const lists = await priceListsByName(this.db, tenant.tenantId, business.id);
    const seen = new Set<string>();

    /** What to save for a row, and what to add once the product exists (ADR-065). */
    type Extra = {
      categoryPath: string | null;
      brand: string | null;
      supplier: string | null;
      supplierCode: string;
      priceList: { id: string; priceMinor: bigint } | null;
      item: string | null;
      variant: string | null;
    };
    type Plan = { row: number; existing: ProductRow | null; body: Record<string, unknown>; extra: Extra };
    const plans: Plan[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const variant = row.variant.trim() || null;
      const itemName = variant ? (row.item.trim() || row.name.trim()) : null;
      // A variant row is "Polo shirt" + "Red / M": the product is "Polo shirt Red / M".
      const name = variant && itemName ? variantName(itemName, variant) : row.name.trim();
      if (!name) errors.push({ field: "name", message: "Enter the product name." });
      if (name.length > 160) errors.push({ field: "name", message: "Use 160 characters or fewer." });
      if (variant && variant.length > 80) errors.push({ field: "variant", message: "Use 80 characters or fewer." });
      const key = name.toLowerCase();
      if (name && seen.has(key)) errors.push({ field: "name", message: "This product is already in the file." });
      seen.add(key);
      const unit = row.unit.trim() ? unitFromText(row.unit) : "piece";
      if (!unit) errors.push({ field: "unit", message: `Unknown unit "${row.unit}". Use piece, carton, bag, kg, litre…` });
      const price = this.money(row.price, "price", errors, business.baseCurrencyCode);
      const cost = this.money(row.cost, "cost", errors, business.baseCurrencyCode);
      if (cost !== null && !seeCost) errors.push({ field: "cost", message: "Only someone who can see cost prices can import them. Leave cost empty." });
      // A file Bizora exported says 0 for none in stock, and may say 0 for the low stock level (ADR-065).
      const quantity = row.quantity.trim() === "0" ? null : this.quantity(row.quantity, "quantity", errors);
      const lowStock = row.lowStock.trim() === "0" ? 0n : this.quantity(row.lowStock, "lowStock", errors);
      const packUnit = row.packUnit.trim() ? unitFromText(row.packUnit) : null;
      if (row.packUnit.trim() && !packUnit) errors.push({ field: "packUnit", message: `Unknown pack "${row.packUnit}".` });
      const packSize = this.quantity(row.packSize, "packSize", errors);
      const packPrice = this.money(row.packPrice, "packPrice", errors, business.baseCurrencyCode);
      if ((packUnit === null) !== (packSize === null)) errors.push({ field: "packSize", message: "Give both the pack and how many are in it." });
      const forSale = yesNo(row.packForSale);
      const forPurchase = yesNo(row.packForPurchase);
      if (forSale === "bad") errors.push({ field: "packForSale", message: "Write yes or no." });
      if (forPurchase === "bad") errors.push({ field: "packForPurchase", message: "Write yes or no." });
      if ((forSale !== null || forPurchase !== null) && !packUnit) errors.push({ field: "packUnit", message: "Name the pack these yes/no answers are for." });
      const sku = row.sku.trim() || null;
      if (sku && !skuSchema.safeParse(sku).success) errors.push({ field: "sku", message: "Use letters, numbers, spaces and . _ - / only, up to 64." });
      const gtin = row.gtin.replace(/\s+/g, "") || null;
      if (gtin && !gtinSchema.safeParse(gtin).success) errors.push({ field: "gtin", message: "This GTIN is not right: check the digits." });
      if (row.category.trim() && categoryLevels(row.category).length > CATEGORY_PATH_MAX) errors.push({ field: "category", message: `Use at most ${CATEGORY_PATH_MAX} levels, like Drinks > Soft drinks.` });
      const supplier = row.supplier.trim() || null;
      if (row.supplierCode.trim() && !supplier) errors.push({ field: "supplier", message: "Name the supplier this code is from." });
      if (supplier && supplier.length < 2) errors.push({ field: "supplier", message: "Write the supplier's name." });
      if (supplier && !managesSuppliers) errors.push({ field: "supplier", message: "Only someone who manages buying can set suppliers. Leave it empty." });
      let priceList: Extra["priceList"] = null;
      const listName = row.priceList.trim();
      const listPrice = this.money(row.priceListPrice, "priceListPrice", errors, business.baseCurrencyCode);
      if (listName || listPrice !== null) {
        const list = lists.get(nameKey(listName));
        if (!listName || listPrice === null) errors.push({ field: listName ? "priceListPrice" : "priceList", message: "Give both the price list and its price." });
        else if (!managesLists) errors.push({ field: "priceList", message: "Only someone who manages price lists can set these prices. Leave them empty." });
        else if (!list) errors.push({ field: "priceList", message: `There is no price list called "${listName}". Add it under Prices first.` });
        else priceList = { id: list.id, priceMinor: listPrice };
      }
      const match = byName.get(key) ?? null;
      if (errors.length > 0) return { row: index + 1, status: "error", errors };

      const packs =
        packUnit && packSize
          ? [
              {
                unitCode: packUnit,
                baseQuantity: decimal(packSize),
                ...(packPrice !== null ? { priceMinor: packPrice.toString() } : {}),
                ...(forSale !== null ? { forSale } : {}),
                ...(forPurchase !== null ? { forPurchase } : {}),
              },
            ]
          : undefined;
      const path = row.category.trim() && categoryLevels(row.category).length > 1 ? row.category.trim() : null;
      const extra: Extra = { categoryPath: path, brand: row.brand.trim() || null, supplier, supplierCode: row.supplierCode, priceList, item: itemName, variant };
      const codes = { ...(sku ? { sku } : {}), ...(gtin ? { gtin } : {}) };
      if (match) {
        const current = units.get(match.id) ?? [];
        const body = this.updateBody(match, current, { category: path ? "" : row.category, price, cost, lowStock, barcode: row.barcode, packs, seeCost });
        plans.push({ row: index + 1, existing: match, body: { ...body, ...codes, sku: sku ?? match.sku, gtin: gtin ?? match.gtin }, extra });
        return {
          row: index + 1,
          status: "update",
          message: quantity !== null ? "Already exists: prices updated. The quantity is ignored; count this product to change its stock." : "Already exists: details updated.",
        };
      }
      plans.push({
        row: index + 1,
        existing: null,
        extra,
        body: {
          name,
          ...(path ? {} : { category: row.category.trim() || null }),
          baseUnit: unit,
          priceMinor: price?.toString() ?? null,
          lowStockLevel: lowStock !== null ? decimal(lowStock) : null,
          barcode: row.barcode.trim() || null,
          ...codes,
          ...(packs ? { packs } : {}),
          ...(cost !== null ? { defaultCostMinor: cost.toString() } : {}),
          ...(quantity !== null ? { openingQuantity: decimal(quantity) } : {}),
          ...(quantity !== null && cost !== null ? { openingCostMinor: round(cost * quantity, 1000n).toString() } : {}),
        },
      });
      const what = variant ? `New variant ${variant} of ${itemName}` : "New product";
      return { row: index + 1, status: "create", message: quantity !== null ? `${what} with ${decimal(quantity)} ${unit} in stock.` : `${what}.` };
    });

    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false);
    const reason = payload.source === "capture" ? "Updated from a photo or scan" : "Updated from a product file";
    // Variants of the same new item are made together, as one item (ADR-046).
    const items = new Map<string, string>();
    for (const plan of plans) {
      const { extra } = plan;
      const categoryId = extra.categoryPath ? await categoryFromPath(this.db, tenant, business.id, extra.categoryPath) : undefined;
      const brandId = extra.brand ? await brandFromName(this.db, tenant, business.id, extra.brand) : undefined;
      const linked = { ...(categoryId ? { categoryId } : {}), ...(brandId ? { brandId } : {}) };
      let productId: string;
      if (plan.existing) {
        await this.productService.update(tenant, plan.existing.id, { ...plan.body, ...linked, changeReason: reason });
        productId = plan.existing.id;
      } else if (extra.variant && extra.item) {
        const itemKey = nameKey(extra.item);
        const itemId = items.get(itemKey) ?? (await itemByName(this.db, tenant.tenantId, business.id, extra.item))?.id;
        if (itemId) {
          const { name: _name, category: _category, ...variantBody } = plan.body;
          productId = ((await this.productService.create(tenant, { ...variantBody, name: plan.body.name, catalogItemId: itemId, variantLabel: extra.variant })) as { id: string }).id;
          items.set(itemKey, itemId);
        } else {
          const { name: _name, category, ...variantBody } = plan.body;
          const made = await this.catalog.createItem(tenant, {
            name: extra.item,
            ...linked,
            ...(!categoryId && typeof category === "string" && category ? { categoryId: await categoryFromPath(this.db, tenant, business.id, category) } : {}),
            variants: [{ ...variantBody, variantLabel: extra.variant }],
          });
          items.set(itemKey, made.id);
          productId = (made.variants as { id: string }[])[0]!.id;
        }
      } else {
        productId = ((await this.productService.create(tenant, { ...plan.body, ...linked })) as { id: string }).id;
      }
      if (extra.supplier) await setSupplierCode(this.db, tenant, business, productId, extra.supplier, extra.supplierCode);
      if (extra.priceList) {
        const [saved] = await this.db.select({ baseUnit: products.baseUnit }).from(products).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, productId))).limit(1);
        await setListPrice(this.db, tenant, business.id, extra.priceList.id, productId, saved?.baseUnit ?? "piece", extra.priceList.priceMinor);
      }
    }
    await this.recordImport(tenant, business.id, "products", payload.source, results.length);
    return this.outcome(results, true);
  }

  async salesImport(tenant: TenantContext, raw: unknown) {
    const payload = salesImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id);
    const today = localDate(new Date(), business.timezone);
    const oldest = localDate(new Date(Date.now() - 7 * 86_400_000), business.timezone);
    const productRows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)));
    const byName = new Map(productRows.map((product) => [product.name.trim().toLowerCase(), product]));
    const units = await productUnitsFor(this.db, tenant.tenantId, productRows.map((product) => product.id));
    const customerRows = await this.db
      .select({ id: customers.id, name: customers.name, phone: customers.phoneE164 })
      .from(customers)
      .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id)));
    const canDiscount = tenant.permissions.includes(Permission.SALES_DISCOUNT);
    const canCredit = tenant.permissions.includes(Permission.DEBTORS_MANAGE);

    type Line = { product: ProductRow | null; description: string; unit: string; entered: bigint; quantity: bigint; unitPrice: bigint; lineTotal: bigint };
    type Group = { date: string; method: string; customerId: string | null; counts: boolean; ref: string | null; lines: Line[]; rows: number[] };
    const groups = new Map<string, Group>();
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const date = row.date.trim() ? parseTraderDate(row.date) : today;
      if (!date) errors.push({ field: "date", message: `Can't read the date "${row.date}". Write it like 16/11/2026.` });
      else if (date > today) errors.push({ field: "date", message: "This date is in the future." });
      const counts = payload.mode === "full" ? true : payload.mode === "history" ? false : date === today;
      const product = byName.get(row.product.trim().toLowerCase()) ?? null;
      if (!row.product.trim()) errors.push({ field: "product", message: "Enter what was sold." });
      else if (!product && counts) errors.push({ field: "product", message: `"${row.product}" is not in your products. Add it first, or import this sale as history.` });
      const productUnits = product ? (units.get(product.id) ?? []) : [];
      const unit = row.unit.trim() ? unitFromText(row.unit) : (product?.baseUnit ?? "piece");
      if (!unit) errors.push({ field: "unit", message: `Unknown unit "${row.unit}".` });
      const factor = product && unit ? this.factor(product, productUnits, unit) : 1000n;
      if (product && unit && factor === null) errors.push({ field: "unit", message: `${product.name} is not sold in ${unit}.` });
      const entered = row.quantity.trim() ? parseQuantity(row.quantity) : 1000n;
      if (entered === null) errors.push({ field: "quantity", message: `Can't read the quantity "${row.quantity}".` });
      const total = this.money(row.total, "total", errors, business.baseCurrencyCode);
      // A known product sold without a written price is taken at its list price (common in sales books and voice notes).
      const listed = product && unit && factor !== null && !row.price.trim() && total === null ? this.listPrice(product, productUnits, unit, factor) : null;
      const price = listed ?? this.money(row.price, "price", errors, business.baseCurrencyCode);
      if (price === null && total === null) errors.push({ field: "price", message: "Enter the price or the total." });
      const method = paymentFromText(row.payment);
      if (!method) errors.push({ field: "payment", message: `Can't read "${row.payment}". Use cash, transfer, POS or credit.` });
      const phone = row.phone.trim() ? normalizePhoneToE164(row.phone, business.countryCode.trim()) : null;
      const customer =
        (phone ? customerRows.find((item) => item.phone === phone) : undefined) ??
        (row.customer.trim() ? customerRows.find((item) => item.name.trim().toLowerCase() === row.customer.trim().toLowerCase()) : undefined);
      if (counts && date && date < oldest) errors.push({ field: "date", message: "Older than 7 days: import it as history." });
      if (counts && method === "credit") {
        if (!customer) errors.push({ field: "customer", message: "A sale on credit needs a customer who is already in Customers." });
        if (!canCredit) errors.push({ field: "payment", message: "Only a manager can record sales on credit." });
      }
      let unitPrice = 0n;
      let lineTotal = 0n;
      if (entered !== null && (price !== null || total !== null)) {
        unitPrice = price ?? round((total as bigint) * 1000n, entered);
        lineTotal = total ?? round(unitPrice * entered, 1000n);
      }
      if (counts && product && unit && factor !== null && entered !== null) {
        const listPrice = this.listPrice(product, productUnits, unit, factor);
        if (listPrice !== null && unitPrice < listPrice && !canDiscount) {
          errors.push({ field: "price", message: `Below the price of ${product.name}. Only a manager can import discounted sales.` });
        }
      }
      if (errors.length > 0) return { row: index + 1, status: "error", errors, counts };

      const key = row.ref.trim() ? `ref:${row.ref.trim()}` : `row:${index}`;
      const group = groups.get(key) ?? {
        date: date as string,
        method: method as string,
        customerId: customer?.id ?? null,
        counts,
        ref: row.ref.trim() || null,
        lines: [],
        rows: [],
      };
      if (group.date !== date || group.counts !== counts) {
        return { row: index + 1, status: "error", errors: [{ field: "ref", message: "Rows with the same receipt number must have the same date." }], counts };
      }
      group.lines.push({
        product,
        description: product?.name ?? row.product.trim(),
        unit: unit as string,
        entered: entered as bigint,
        quantity: product ? round((entered as bigint) * (factor as bigint), 1000n) : (entered as bigint),
        unitPrice,
        lineTotal,
      });
      group.rows.push(index + 1);
      groups.set(key, group);
      return {
        row: index + 1,
        status: "create",
        counts,
        message: counts ? "Counts fully: stock goes down and the money is recorded." : "History only: kept for your records, stock and accounts unchanged.",
      };
    });

    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false);
    for (const group of groups.values()) {
      if (group.counts) {
        const total = group.lines.reduce((sum, line) => sum + line.lineTotal, 0n);
        await this.sales.create(
          tenant,
          {
            lines: group.lines.map((line) => ({
              productId: (line.product as ProductRow).id,
              quantity: decimal(line.entered),
              unit: line.unit,
              unitPriceMinor: line.unitPrice.toString(),
            })),
            payments: group.method === "credit" || total === 0n ? [] : [{ method: group.method, amountMinor: total.toString() }],
            ...(group.customerId ? { customerId: group.customerId } : {}),
            ...(group.ref ? { note: `Imported ${group.ref}` } : { note: "Imported" }),
          },
          { source: payload.source === "capture" ? "capture" : "import", soldAt: group.date === today ? new Date() : zonedDateTime(group.date, "12:00:00", business.timezone) },
        );
      } else {
        await this.db.transaction((tx) =>
          this.sales.createHistory(tx, tenant, business, branch.id, {
            soldAt: zonedDateTime(group.date, "12:00:00", business.timezone),
            externalRef: group.ref,
            customerId: group.customerId,
            lines: group.lines,
            paid: group.method === "credit" ? [] : [{ method: group.method, amount: group.lines.reduce((sum, line) => sum + line.lineTotal, 0n) }],
            source: payload.source === "capture" ? "capture" : "import",
          }),
        );
      }
    }
    await this.recordImport(tenant, business.id, "sales", payload.source, results.length);
    return this.outcome(results, true);
  }

  /**
   * A supplier delivery (stock in), from a CSV file or a captured invoice or delivery note. Every product must
   * already exist. All rows save together or not at all.
   */
  async stockIn(tenant: TenantContext, raw: unknown) {
    const payload = stockInImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const business = await requireBusiness(this.db, tenant);
    const productRows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)));
    const byName = new Map(productRows.map((product) => [product.name.trim().toLowerCase(), product]));
    const units = await productUnitsFor(this.db, tenant.tenantId, productRows.map((product) => product.id));
    const canPay = tenant.permissions.includes(Permission.PURCHASES_MANAGE);

    const plans: { productId: string; quantity: string; unit: string; totalCostMinor?: string; paidFrom: "cash" | "bank" | "credit"; supplier?: string; note?: string }[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const product = byName.get(row.product.trim().toLowerCase()) ?? null;
      if (!row.product.trim()) errors.push({ field: "product", message: "Enter the product received." });
      else if (!product) errors.push({ field: "product", message: `"${row.product}" is not in your products. Add it first, or fix the name.` });
      else if (!product.trackStock) errors.push({ field: "product", message: `${product.name} does not keep stock.` });
      const unit = row.unit.trim() ? unitFromText(row.unit) : (product?.baseUnit ?? null);
      if (row.unit.trim() && !unit) errors.push({ field: "unit", message: `Unknown unit "${row.unit}".` });
      if (product && unit && this.factor(product, units.get(product.id) ?? [], unit) === null) errors.push({ field: "unit", message: `${product.name} does not come in ${unit}.` });
      const quantity = row.quantity.trim() ? parseQuantity(row.quantity) : null;
      if (quantity === null || quantity <= 0n) errors.push({ field: "quantity", message: row.quantity.trim() ? `Can't read the quantity "${row.quantity}".` : "Enter how many were received." });
      const cost = this.money(row.cost, "cost", errors, business.baseCurrencyCode);
      const paidFrom = paidFromText(row.paid);
      if (!paidFrom) errors.push({ field: "paid", message: `Can't read "${row.paid}". Use owed, cash or bank.` });
      else if (paidFrom !== "credit" && !canPay) errors.push({ field: "paid", message: "Only a manager can record paying the supplier. Leave it as owed." });
      if (errors.length > 0 || !product || !unit || quantity === null || !paidFrom) return { row: index + 1, status: "error", errors };
      plans.push({
        productId: product.id,
        quantity: decimal(quantity),
        unit,
        paidFrom,
        ...(cost !== null ? { totalCostMinor: cost.toString() } : {}),
        ...(row.supplier.trim() ? { supplier: row.supplier.trim().slice(0, 160) } : {}),
        ...(row.ref.trim() ? { note: `Delivery ${row.ref.trim()}`.slice(0, 280) } : {}),
      });
      return { row: index + 1, status: "create", message: `${decimal(quantity)} ${unit} of ${product.name} received${paidFrom === "credit" ? ", owed to the supplier" : ""}.` };
    });

    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false, this.stock.needsApproval(tenant));
    await this.db.transaction(async (tx) => {
      for (const plan of plans) {
        const delivery = stockReceiveSchema.parse(plan);
        if (this.stock.needsApproval(tenant)) await this.stock.ask(tx, tenant, "receive", delivery);
        else await this.stock.receiveIn(tx, tenant, delivery);
      }
    });
    await this.recordImport(tenant, business.id, "stock_in", payload.source, results.length);
    return this.outcome(results, true, this.stock.needsApproval(tenant));
  }

  // Spoken, photographed or file lists of stock counts, changes and moves (ADR-033) ---------------------------------

  /** A count list: each row becomes a count (approved at once for those who may adjust stock, else waiting). */
  async stockCount(tenant: TenantContext, raw: unknown) {
    const payload = stockCountImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const { business, branch, match, units } = await this.stockScope(tenant);
    const plans: ReturnType<typeof stockCountSchema.parse>[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const product = this.stockProduct(row.product, match, errors);
      const unit = this.stockUnit(row.unit, product, units, errors);
      const counted = row.counted.trim() ? parseCountQuantity(row.counted) : null;
      if (counted === null) errors.push({ field: "counted", message: row.counted.trim() ? `Can't read the number "${row.counted}".` : "Enter how many were counted." });
      if (errors.length > 0 || !product || !unit || counted === null) return { row: index + 1, status: "error", errors };
      plans.push(stockCountSchema.parse({ productId: product.id, branchId: branch.id, countedQuantity: decimal(counted), unit, ...(row.note.trim() ? { note: row.note.trim().slice(0, 240) } : {}) }));
      return { row: index + 1, status: "create", message: `${decimal(counted)} ${unit} of ${product.name} counted in ${branch.name}.` };
    });
    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false, this.stock.needsApproval(tenant));
    await this.db.transaction(async (tx) => {
      for (const plan of plans) await this.stock.countIn(tx, tenant, plan);
    });
    await this.recordImport(tenant, business.id, "stock_count", payload.source, results.length);
    return this.outcome(results, true, this.stock.needsApproval(tenant));
  }

  /** Goods taken off or added by hand. Every row says what happened; nothing may take a shelf below zero. */
  async stockChange(tenant: TenantContext, raw: unknown) {
    const payload = stockChangeImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const { business, branch, match, units, onHand } = await this.stockScope(tenant);
    const left = new Map(onHand);
    const plans: ReturnType<typeof stockAdjustSchema.parse>[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const product = this.stockProduct(row.product, match, errors);
      const unit = this.stockUnit(row.unit, product, units, errors);
      const quantity = row.quantity.trim() ? parseQuantity(row.quantity) : null;
      if (quantity === null || quantity <= 0n) errors.push({ field: "quantity", message: row.quantity.trim() ? `Can't read the quantity "${row.quantity}".` : "Enter how many." });
      const reason = reasonFromText(row.reason);
      const direction = directionFromText(row.change) ?? (reason ? ((STOCK_ADD_REASONS as readonly string[]).includes(reason) ? "add" : "remove") : null);
      if (!direction) errors.push({ field: "change", message: `Can't read "${row.change}". Use remove or add.` });
      const chosen = reason ?? (direction === "add" ? "found" : direction === "remove" ? "other" : null);
      if (direction && chosen && !(direction === "remove" ? (STOCK_REMOVE_REASONS as readonly string[]) : (STOCK_ADD_REASONS as readonly string[])).includes(chosen)) {
        errors.push({ field: "reason", message: direction === "remove" ? "Use damaged, expired, missing, own use, gift or other." : "Use found or correction." });
      }
      const note = row.note.trim();
      if (note.length < 3) errors.push({ field: "note", message: "Say what happened, in a few words." });
      const factor = product && unit ? this.factor(product, units.get(product.id) ?? [], unit) : null;
      if (direction === "remove" && product && quantity !== null && factor !== null && errors.length === 0) {
        const base = (quantity * factor) / 1000n;
        const have = left.get(product.id) ?? 0n;
        if (base > have) errors.push({ field: "quantity", message: `Only ${quantityToString(have > 0n ? have : 0n)} ${product.baseUnit} of ${product.name} left in ${branch.name}.` });
        else left.set(product.id, have - base);
      }
      if (errors.length > 0 || !product || !unit || quantity === null || !direction || !chosen) return { row: index + 1, status: "error", errors };
      plans.push(stockAdjustSchema.parse({ productId: product.id, branchId: branch.id, direction, reason: chosen, quantity: decimal(quantity), unit, note: note.slice(0, 240) }));
      return { row: index + 1, status: "create", message: `${direction === "remove" ? "Take off" : "Add"} ${decimal(quantity)} ${unit} of ${product.name} (${chosen.replace("_", " ")}).` };
    });
    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false, this.stock.needsApproval(tenant));
    await this.db.transaction(async (tx) => {
      for (const plan of plans) {
        if (this.stock.needsApproval(tenant)) await this.stock.ask(tx, tenant, "adjust", plan);
        else await this.stock.adjustIn(tx, tenant, plan);
      }
    });
    await this.recordImport(tenant, business.id, "stock_change", payload.source, results.length);
    return this.outcome(results, true, this.stock.needsApproval(tenant));
  }

  /** Goods moved from the shop being worked in to another open shop, by its name. */
  async stockMove(tenant: TenantContext, raw: unknown) {
    const payload = stockMoveImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const { business, branch, match, units, onHand } = await this.stockScope(tenant);
    const shops = await this.db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, business.id), ne(branches.id, branch.id), isNull(branches.closedAt)));
    const shopByName = new Map(shops.map((shop) => [shop.name.trim().toLowerCase(), shop]));
    const left = new Map(onHand);
    const plans: ReturnType<typeof stockTransferSchema.parse>[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const product = this.stockProduct(row.product, match, errors);
      const unit = this.stockUnit(row.unit, product, units, errors);
      const quantity = row.quantity.trim() ? parseQuantity(row.quantity) : null;
      if (quantity === null || quantity <= 0n) errors.push({ field: "quantity", message: row.quantity.trim() ? `Can't read the quantity "${row.quantity}".` : "Enter how many." });
      const to = shopByName.get(row.toShop.trim().toLowerCase()) ?? null;
      if (!to) errors.push({ field: "toShop", message: row.toShop.trim() ? `"${row.toShop}" is not one of your other open shops.` : "Enter the shop the goods went to." });
      const factor = product && unit ? this.factor(product, units.get(product.id) ?? [], unit) : null;
      if (product && quantity !== null && factor !== null && errors.length === 0) {
        const base = (quantity * factor) / 1000n;
        const have = left.get(product.id) ?? 0n;
        if (base > have) errors.push({ field: "quantity", message: `Only ${quantityToString(have > 0n ? have : 0n)} ${product.baseUnit} of ${product.name} left in ${branch.name}.` });
        else left.set(product.id, have - base);
      }
      if (errors.length > 0 || !product || !unit || quantity === null || !to) return { row: index + 1, status: "error", errors };
      plans.push(stockTransferSchema.parse({ productId: product.id, fromBranchId: branch.id, toBranchId: to.id, quantity: decimal(quantity), unit, ...(row.note.trim() ? { note: row.note.trim().slice(0, 240) } : {}) }));
      return { row: index + 1, status: "create", message: `Move ${decimal(quantity)} ${unit} of ${product.name} to ${to.name}.` };
    });
    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false, this.stock.needsApproval(tenant));
    await this.db.transaction(async (tx) => {
      for (const plan of plans) {
        if (this.stock.needsApproval(tenant)) await this.stock.ask(tx, tenant, "transfer", plan);
        else await this.stock.transferIn(tx, tenant, plan);
      }
    });
    await this.recordImport(tenant, business.id, "stock_move", payload.source, results.length);
    return this.outcome(results, true, this.stock.needsApproval(tenant));
  }

  /** The shop being worked in, its products by name, their packs and what is on hand. */
  private async stockScope(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id);
    const productRows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)));
    const match = new Map(productRows.map((product) => [product.name.trim().toLowerCase(), product]));
    const units = await productUnitsFor(this.db, tenant.tenantId, productRows.map((product) => product.id));
    const balances = productRows.length
      ? await this.db
          .select({ productId: stockBalances.productId, quantity: stockBalances.quantity })
          .from(stockBalances)
          .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, branch.id), inArray(stockBalances.productId, productRows.map((product) => product.id))))
      : [];
    return { business, branch, match, units, onHand: new Map(balances.map((row) => [row.productId, row.quantity])) };
  }

  private stockProduct(text: string, match: Map<string, ProductRow>, errors: { field: string; message: string }[]) {
    if (!text.trim()) {
      errors.push({ field: "product", message: "Enter the product." });
      return null;
    }
    const product = match.get(text.trim().toLowerCase()) ?? null;
    if (!product) errors.push({ field: "product", message: `"${text}" is not in your products. Fix the name to match one.` });
    else if (!product.trackStock) errors.push({ field: "product", message: `${product.name} does not keep stock.` });
    return product && product.trackStock ? product : null;
  }

  private stockUnit(text: string, product: ProductRow | null, units: Map<string, ProductUnitRow[]>, errors: { field: string; message: string }[]) {
    const unit = text.trim() ? unitFromText(text) : (product?.baseUnit ?? null);
    if (text.trim() && !unit) errors.push({ field: "unit", message: `Unknown unit "${text}".` });
    if (product && unit && this.factor(product, units.get(product.id) ?? [], unit) === null) errors.push({ field: "unit", message: `${product.name} does not come in ${unit}.` });
    return unit;
  }

  private async recordImport(tenant: TenantContext, businessId: string, kind: string, source: "file" | "capture", rows: number) {
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "import.saved",
      entityType: "import",
      entityId: null,
      correlationId: tenant.correlationId,
      businessId,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { kind, source, rows },
    });
  }

  private updateBody(
    product: ProductRow,
    current: ProductUnitRow[],
    changes: { category: string; price: bigint | null; cost: bigint | null; lowStock: bigint | null; barcode: string; packs?: { unitCode: string; baseQuantity: string; priceMinor?: string; forSale?: boolean; forPurchase?: boolean }[]; seeCost: boolean },
  ) {
    // The file's pack replaces the pack with the same unit; the product's other packs are kept (ADR-065).
    const kept = current.map((unit) => ({
      unitCode: unit.unitCode,
      baseQuantity: decimal(unit.baseQuantity),
      ...(unit.priceMinor !== null ? { priceMinor: unit.priceMinor.toString() } : {}),
      forSale: unit.forSale,
      forPurchase: unit.forPurchase,
    }));
    const given = changes.packs ?? [];
    const packs = [...kept.filter((unit) => !given.some((pack) => pack.unitCode === unit.unitCode)), ...given];
    return {
      name: product.name,
      category: changes.category.trim() || product.category,
      baseUnit: product.baseUnit,
      priceMinor: (changes.price ?? product.priceMinor)?.toString() ?? null,
      lowStockLevel: changes.lowStock !== null ? decimal(changes.lowStock) : product.lowStockLevel !== null ? decimal(product.lowStockLevel) : null,
      barcode: changes.barcode.trim() || product.barcode,
      trackStock: product.trackStock,
      packs,
      ...(changes.seeCost ? { defaultCostMinor: (changes.cost ?? product.defaultCostMinor)?.toString() ?? null } : {}),
    };
  }

  private listPrice(product: ProductRow, units: ProductUnitRow[], unit: string, factor: bigint) {
    if (unit === product.baseUnit) return product.priceMinor;
    const pack = units.find((item) => item.unitCode === unit);
    return pack?.priceMinor ?? (product.priceMinor !== null ? round(product.priceMinor * factor, 1000n) : null);
  }

  private factor(product: ProductRow, units: ProductUnitRow[], unit: string) {
    if (unit === product.baseUnit) return 1000n;
    return units.find((item) => item.unitCode === unit)?.baseQuantity ?? null;
  }

  /** Amounts follow the business's currency: two decimals for NGN, none for XOF (ADR-027). */
  private money(text: string, field: string, errors: { field: string; message: string }[], currency: string) {
    if (!text.trim()) return null;
    const digits = currencyDigits(currency.trim());
    const value = parseMoneyInput(text, digits);
    const example = digits > 0 ? `1500 or 1,500.${"5".padEnd(digits, "0")}` : "1500 or 1,500";
    if (value === null) errors.push({ field, message: `Can't read the amount "${text}". Write it like ${example}.` });
    return value;
  }

  private quantity(text: string, field: string, errors: { field: string; message: string }[]) {
    if (!text.trim()) return null;
    const value = parseQuantity(text);
    if (value === null) errors.push({ field, message: `Can't read the number "${text}".` });
    return value;
  }

  private assertSize(rows: number) {
    if (rows > IMPORT_MAX_ROWS) {
      throw new ApiError("TOO_MANY_ROWS", `The file has ${rows} rows. Import at most ${IMPORT_MAX_ROWS} rows at a time; split the file and import each part.`, 400);
    }
  }

  /** `waiting`: the rows go to a manager or owner to approve instead of changing stock at once (ADR-034). */
  private outcome(results: ImportRowResult[], committed: boolean, waiting = false) {
    const count = (status: ImportRowResult["status"]) => results.filter((result) => result.status === status).length;
    const shown = waiting ? results.map((result) => (result.status === "error" || !result.message ? result : { ...result, message: `Waits for a manager or owner: ${result.message}` })) : results;
    return { committed, waiting, results: shown, totals: { create: count("create"), update: count("update"), error: count("error") } };
  }
}

/** "remove", "out", "minus" → remove; "add", "in", "found" → add. */
function directionFromText(text: string): "remove" | "add" | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  if (/^(remove|take off|take out|out|minus|less|reduce|-)/.test(value)) return "remove";
  if (/^(add|put back|in|plus|increase|found|\+)/.test(value)) return "add";
  return null;
}

/** Plain words for why stock changed, as traders say them ("got wet", "rat chop am", "we used two"). */
function reasonFromText(text: string) {
  const value = ` ${text.trim().toLowerCase().replace(/[^a-z']+/g, " ")} `;
  if (!value.trim()) return null;
  const said = (pattern: string) => new RegExp(` (${pattern})`).test(value);
  if (said("correct|mistake|error|recount|wrong count")) return "correction";
  if (said("found|extra")) return "found";
  if (said("expir|out of date|old stock")) return "expired";
  if (said("damag|broke|spoil|wet|rat|leak|torn|crush|dent|spill|melt|rotten|bad")) return "damaged";
  if (said("miss|stolen|steal|theft|thief|lost|can't find|cannot find|short")) return "missing";
  if (said("own use|shop use|used|use|staff|we ate|drank|ate")) return "own_use";
  if (said("gift|dash|free|sample|promo|give away|gave")) return "gift";
  if (said("other")) return "other";
  return null;
}
