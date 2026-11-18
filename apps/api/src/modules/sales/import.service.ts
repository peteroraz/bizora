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
  productImportSchema,
  salesImportSchema,
  stockInImportSchema,
  stockReceiveSchema,
  unitFromText,
  type ImportRowResult,
} from "@bizora/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { customers, products } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { productUnitsFor, requireBusiness, resolveBranch, type ProductRow, type ProductUnitRow } from "../inventory/inventory-scope.js";
import { AuditService } from "../audit/audit.service.js";
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
  ) {}

  async products(tenant: TenantContext, raw: unknown) {
    const payload = productImportSchema.parse(raw);
    this.assertSize(payload.rows.length);
    const business = await requireBusiness(this.db, tenant);
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const existing = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)));
    const byName = new Map(existing.map((product) => [product.name.trim().toLowerCase(), product]));
    const units = await productUnitsFor(this.db, tenant.tenantId, existing.map((product) => product.id));
    const seen = new Set<string>();

    type Plan = { row: number; existing: ProductRow | null; body: Record<string, unknown> };
    const plans: Plan[] = [];
    const results: ImportRowResult[] = payload.rows.map((row, index) => {
      const errors: { field: string; message: string }[] = [];
      const name = row.name.trim();
      if (!name) errors.push({ field: "name", message: "Enter the product name." });
      if (name.length > 160) errors.push({ field: "name", message: "Use 160 characters or fewer." });
      const key = name.toLowerCase();
      if (name && seen.has(key)) errors.push({ field: "name", message: "This product is already in the file." });
      seen.add(key);
      const unit = row.unit.trim() ? unitFromText(row.unit) : "piece";
      if (!unit) errors.push({ field: "unit", message: `Unknown unit "${row.unit}". Use piece, carton, bag, kg, litre…` });
      const price = this.money(row.price, "price", errors, business.baseCurrencyCode);
      const cost = this.money(row.cost, "cost", errors, business.baseCurrencyCode);
      if (cost !== null && !seeCost) errors.push({ field: "cost", message: "Only someone who can see cost prices can import them. Leave cost empty." });
      const quantity = this.quantity(row.quantity, "quantity", errors);
      const lowStock = this.quantity(row.lowStock, "lowStock", errors);
      const packUnit = row.packUnit.trim() ? unitFromText(row.packUnit) : null;
      if (row.packUnit.trim() && !packUnit) errors.push({ field: "packUnit", message: `Unknown pack "${row.packUnit}".` });
      const packSize = this.quantity(row.packSize, "packSize", errors);
      const packPrice = this.money(row.packPrice, "packPrice", errors, business.baseCurrencyCode);
      if ((packUnit === null) !== (packSize === null)) errors.push({ field: "packSize", message: "Give both the pack and how many are in it." });
      const match = byName.get(key) ?? null;
      if (errors.length > 0) return { row: index + 1, status: "error", errors };

      const packs =
        packUnit && packSize
          ? [{ unitCode: packUnit, baseQuantity: decimal(packSize), ...(packPrice !== null ? { priceMinor: packPrice.toString() } : {}) }]
          : undefined;
      if (match) {
        const current = units.get(match.id) ?? [];
        plans.push({ row: index + 1, existing: match, body: this.updateBody(match, current, { category: row.category, price, cost, lowStock, barcode: row.barcode, packs, seeCost }) });
        return {
          row: index + 1,
          status: "update",
          message: quantity !== null ? "Already exists: prices updated. The quantity is ignored; count this product to change its stock." : "Already exists: details updated.",
        };
      }
      plans.push({
        row: index + 1,
        existing: null,
        body: {
          name,
          category: row.category.trim() || null,
          baseUnit: unit,
          priceMinor: price?.toString() ?? null,
          lowStockLevel: lowStock !== null ? decimal(lowStock) : null,
          barcode: row.barcode.trim() || null,
          ...(packs ? { packs } : {}),
          ...(cost !== null ? { defaultCostMinor: cost.toString() } : {}),
          ...(quantity !== null ? { openingQuantity: decimal(quantity) } : {}),
          ...(quantity !== null && cost !== null ? { openingCostMinor: round(cost * quantity, 1000n).toString() } : {}),
        },
      });
      return { row: index + 1, status: "create", message: quantity !== null ? `New product with ${decimal(quantity)} ${unit} in stock.` : "New product." };
    });

    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false);
    for (const plan of plans) {
      if (plan.existing) await this.productService.update(tenant, plan.existing.id, plan.body);
      else await this.productService.create(tenant, plan.body);
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

    if (payload.dryRun || results.some((result) => result.status === "error")) return this.outcome(results, false);
    await this.db.transaction(async (tx) => {
      for (const plan of plans) await this.stock.receiveIn(tx, tenant, stockReceiveSchema.parse(plan));
    });
    await this.recordImport(tenant, business.id, "stock_in", payload.source, results.length);
    return this.outcome(results, true);
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
    changes: { category: string; price: bigint | null; cost: bigint | null; lowStock: bigint | null; barcode: string; packs?: { unitCode: string; baseQuantity: string; priceMinor?: string }[]; seeCost: boolean },
  ) {
    const packs =
      changes.packs ??
      current.map((unit) => ({ unitCode: unit.unitCode, baseQuantity: decimal(unit.baseQuantity), ...(unit.priceMinor !== null ? { priceMinor: unit.priceMinor.toString() } : {}) }));
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

  private outcome(results: ImportRowResult[], committed: boolean) {
    const count = (status: ImportRowResult["status"]) => results.filter((result) => result.status === status).length;
    return { committed, results, totals: { create: count("create"), update: count("update"), error: count("error") } };
  }
}
