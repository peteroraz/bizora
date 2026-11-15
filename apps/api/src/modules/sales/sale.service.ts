import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  businessTypeFromIndustry,
  parseQuantity,
  Permission,
  SALE_PAGE_SIZE,
  saleCreateSchema,
  saleVoidSchema,
  whatsAppHref,
  type SaleCreateInput,
} from "@bizora/contracts";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, customers, products, saleLines, salePayments, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { findBranch, productUnitsFor, requireBusiness, resolveBranch, unitFactor, type BusinessRow, type ProductRow } from "../inventory/inventory-scope.js";
import { StockService } from "../inventory/stock.service.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";

type SaleRow = typeof sales.$inferSelect;
export type SaleSource = "pos" | "offline" | "import" | "capture";

const SEVEN_DAYS_MS = 7 * 86_400_000;

const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);

/**
 * Quick sales (ADR-015). One transaction per sale: stock leaves at weighted-average cost (cost of goods sold is
 * posted with each movement), the money and revenue are posted as one balanced entry, and the sale gets the next
 * official receipt number. Cancelling reverses the entry and returns the stock at the cost it left with.
 */
@Injectable()
export class SaleService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, raw: unknown, options: { source?: SaleSource; soldAt?: Date; allowOlder?: boolean } = {}) {
    const payload = saleCreateSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(sales).where(eq(sales.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const soldAt = options.soldAt ?? this.soldAt(payload.soldAt, options.allowOlder);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id);
      const customerId = payload.customerId ? await this.requireCustomer(tx, tenant, business.id, payload.customerId) : null;
      const lines = await this.priceLines(tx, tenant, business, payload);

      const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0n);
      const discount = payload.discountMinor ? BigInt(payload.discountMinor) : 0n;
      if (discount > 0n && !tenant.permissions.includes(Permission.SALES_DISCOUNT)) {
        throw new ApiError("FORBIDDEN", "Ask a manager to give a discount.", 403, [{ field: "discountMinor", message: "Remove the discount." }]);
      }
      if (discount > subtotal) throw new ApiError("VALIDATION_ERROR", "The discount is more than the sale.", 400, [{ field: "discountMinor", message: "Too large." }]);
      const total = subtotal - discount;
      const paidByMethod = new Map<string, bigint>();
      for (const payment of payload.payments) {
        paidByMethod.set(payment.method, (paidByMethod.get(payment.method) ?? 0n) + BigInt(payment.amountMinor));
      }
      const paid = [...paidByMethod.values()].reduce((sum, amount) => sum + amount, 0n);
      if (paid > total) {
        throw new ApiError("OVERPAID", "Payments add up to more than the total. Record only what the sale costs; give change from the drawer.", 400, [
          { field: "payments", message: "Too much." },
        ]);
      }
      const balance = total - paid;
      if (balance > 0n) {
        if (!customerId) {
          throw new ApiError("CUSTOMER_REQUIRED", "Choose the customer who will owe the balance.", 400, [{ field: "customerId", message: "Required for credit." }]);
        }
        if (!tenant.permissions.includes(Permission.DEBTORS_MANAGE)) {
          throw new ApiError("FORBIDDEN", "Only a manager can sell on credit. Take full payment or ask a manager.", 403, [{ field: "payments", message: "Full payment needed." }]);
        }
      }

      const number = await this.numbers.next(tx, tenant.tenantId, business.id, "receipt");
      const context = { tenant, business, branch };
      const movements: { lineIndex: number; id: string; cost: bigint }[] = [];
      for (const [index, line] of lines.entries()) {
        if (!line.product.trackStock) continue;
        const movement = await this.stock.applyMovement(tx, { ...context, product: line.product }, {
          type: "sold",
          quantity: -line.quantity,
          enteredQuantity: line.entered,
          enteredUnit: line.unit,
          note: number.number,
          occurredAt: soldAt,
        });
        movements.push({ lineIndex: index, id: movement.id, cost: -movement.valueMinor });
      }

      const income = businessTypeFromIndustry(business.industryCode) === "services" ? "service_income" : "sales";
      const posting: PostingLine[] = [];
      const methodAccount = { cash: { role: "cash" as const, branchId: branch.id }, transfer: { role: "bank" as const }, pos: { role: "pos_clearing" as const } };
      for (const [method, amount] of paidByMethod) {
        if (amount > 0n) posting.push({ account: methodAccount[method as keyof typeof methodAccount], debitMinor: amount, memo: method });
      }
      if (balance > 0n) posting.push({ account: { role: "debtors" }, debitMinor: balance, memo: "Owed by customer" });
      if (discount > 0n) posting.push({ account: { role: "discounts" }, debitMinor: discount });
      if (subtotal > 0n) posting.push({ account: { role: income }, creditMinor: subtotal });
      let journalEntryId: string | null = null;
      if (posting.length >= 2) {
        const posted = await this.ledger.post(
          tx,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          {
            businessId: business.id,
            branchId: branch.id,
            entryDate: localDate(soldAt, business.timezone),
            source: { type: "sale", id },
            postingKey: `sale:${id}`,
            description: `Sale ${number.number}`,
            lines: posting,
          },
        );
        journalEntryId = posted.entryId;
      }

      await tx.insert(sales).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        customerId,
        saleNumber: number.number,
        provisionalNumber: payload.provisionalNumber ?? null,
        status: "completed",
        historyOnly: false,
        source: options.source ?? "pos",
        currencyCode: business.baseCurrencyCode.trim(),
        subtotalMinor: subtotal,
        discountMinor: discount,
        totalMinor: total,
        paidMinor: paid,
        balanceMinor: balance,
        note: payload.note ?? null,
        receiptToken: randomBytes(24).toString("base64url"),
        journalEntryId,
        soldAt,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
        actorType: tenant.actorType ?? "HUMAN",
      });
      await this.insertLines(tx, tenant, business.id, id, lines, movements);
      if (paidByMethod.size > 0) {
        await tx.insert(salePayments).values(
          payload.payments.map((payment) => ({
            id: newId(),
            tenantId: tenant.tenantId,
            businessId: business.id,
            saleId: id,
            method: payment.method,
            amountMinor: BigInt(payment.amountMinor),
            reference: payment.reference ?? null,
          })),
        );
      }
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "sale.created",
          entityType: "sale",
          entityId: id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          branchId: branch.id,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: { number: number.number, totalMinor: total.toString(), source: options.source ?? "pos" },
        },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  /** A sale kept for the record only: no stock, no accounts, no receipt number (ADR-015, imports). */
  async createHistory(
    tx: DbExecutor,
    tenant: TenantContext,
    business: BusinessRow,
    branchId: string,
    input: {
      soldAt: Date;
      externalRef: string | null;
      customerId: string | null;
      lines: { product: ProductRow | null; description: string; quantity: bigint; entered: bigint; unit: string; unitPrice: bigint; lineTotal: bigint }[];
      paid: { method: string; amount: bigint }[];
      source: SaleSource;
    },
  ) {
    const id = newId();
    const total = input.lines.reduce((sum, line) => sum + line.lineTotal, 0n);
    const paid = input.paid.reduce((sum, payment) => sum + payment.amount, 0n);
    await tx.insert(sales).values({
      id,
      tenantId: tenant.tenantId,
      businessId: business.id,
      branchId,
      customerId: input.customerId,
      saleNumber: null,
      externalRef: input.externalRef,
      status: "completed",
      historyOnly: true,
      source: input.source,
      currencyCode: business.baseCurrencyCode.trim(),
      subtotalMinor: total,
      discountMinor: 0n,
      totalMinor: total,
      paidMinor: paid > total ? total : paid,
      balanceMinor: paid > total ? 0n : total - paid,
      receiptToken: randomBytes(24).toString("base64url"),
      soldAt: input.soldAt,
      createdBy: tenant.userId,
      membershipId: tenant.membershipId,
      deviceId: tenant.deviceId ?? null,
      actorType: tenant.actorType ?? "HUMAN",
    });
    await this.insertLines(
      tx,
      tenant,
      business.id,
      id,
      input.lines.map((line) => ({ ...line, product: line.product })),
      [],
    );
    const payments = input.paid.filter((payment) => payment.amount > 0n);
    if (payments.length > 0) {
      await tx.insert(salePayments).values(
        payments.map((payment) => ({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, saleId: id, method: payment.method, amountMinor: payment.amount })),
      );
    }
    return id;
  }

  async void(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = saleVoidSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const sale = await this.requireSale(tx, tenant, id);
      if (sale.status === "voided") throw new ApiError("ALREADY_VOIDED", "This sale has already been cancelled.", 409);
      const business = await requireBusiness(tx, tenant);
      const today = localDate(new Date(), business.timezone);
      if (!sale.historyOnly && sale.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, sale.journalEntryId, { entryDate: today, reason: `Sale ${sale.saleNumber} cancelled: ${reason}` });
      }
      if (!sale.historyOnly) {
        const lines = await tx.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id)));
        const branch = await findBranch(tx, tenant, business.id, sale.branchId);
        for (const line of lines) {
          if (!line.productId || !line.stockMovementId) continue;
          const [product] = await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, line.productId))).limit(1);
          if (!product) continue;
          await this.stock.applyMovement(tx, { tenant, business, branch, product: { ...product, trackStock: true } }, {
            type: "returned",
            quantity: line.quantity,
            enteredQuantity: line.enteredQuantity,
            enteredUnit: line.enteredUnit,
            reason: "sale_void",
            note: sale.saleNumber,
            valueMinor: line.costMinor ?? 0n,
          });
        }
      }
      await tx.update(sales).set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason }).where(eq(sales.id, sale.id));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "sale.voided",
          entityType: "sale",
          entityId: sale.id,
          correlationId: tenant.correlationId,
          businessId: sale.businessId,
          branchId: sale.branchId,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: { reason },
        },
        tx,
      );
    });
    return this.get(tenant, id);
  }

  async list(tenant: TenantContext, query: { date?: string; page?: number }) {
    const business = await requireBusiness(this.db, tenant);
    const filters = this.scope(tenant, business.id);
    const day = this.day(business, query.date);
    filters.push(gte(sales.soldAt, day.start), lt(sales.soldAt, day.end));
    const page = Math.max(1, query.page ?? 1);
    const [count] = await this.db.select({ total: sql<number>`count(*)::int` }).from(sales).where(and(...filters));
    const rows = await this.db
      .select({ sale: sales, customerName: customers.name, byName: users.displayName })
      .from(sales)
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(users, eq(users.id, sales.createdBy))
      .where(and(...filters))
      .orderBy(desc(sales.soldAt), desc(sales.id))
      .limit(SALE_PAGE_SIZE)
      .offset((page - 1) * SALE_PAGE_SIZE);
    return {
      date: day.date,
      page,
      pageSize: SALE_PAGE_SIZE,
      total: Number(count?.total ?? 0),
      items: rows.map(({ sale, customerName, byName }) => ({ ...this.summaryOf(sale), customerName, byName })),
    };
  }

  /** Totals for one day: number of sales, money in by method, and what was sold on credit. Cancelled sales are left out. */
  async summary(tenant: TenantContext, date?: string) {
    const business = await requireBusiness(this.db, tenant);
    const day = this.day(business, date);
    const filters = [...this.scope(tenant, business.id), gte(sales.soldAt, day.start), lt(sales.soldAt, day.end), eq(sales.status, "completed")];
    const [totals] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${sales.totalMinor}), 0)`,
        credit: sql<string>`coalesce(sum(${sales.balanceMinor}), 0)`,
      })
      .from(sales)
      .where(and(...filters));
    const methods = await this.db
      .select({ method: salePayments.method, amount: sql<string>`coalesce(sum(${salePayments.amountMinor}), 0)` })
      .from(salePayments)
      .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
      .where(and(...filters))
      .groupBy(salePayments.method);
    return {
      date: day.date,
      currency: business.baseCurrencyCode.trim(),
      mine: !tenant.permissions.includes(Permission.SALES_READ_ALL),
      count: Number(totals?.count ?? 0),
      totalMinor: BigInt(totals?.total ?? 0).toString(),
      creditMinor: BigInt(totals?.credit ?? 0).toString(),
      byMethod: Object.fromEntries(methods.map((row) => [row.method, BigInt(row.amount).toString()])),
    };
  }

  async get(tenant: TenantContext, id: string) {
    const sale = await this.requireSale(this.db, tenant, id);
    const [lines, payments, extras] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.saleId, sale.id))).orderBy(asc(salePayments.createdAt)),
      this.db
        .select({ customerName: customers.name, customerPhone: customers.phoneE164, byName: users.displayName, branchName: branches.name, businessName: businesses.name })
        .from(sales)
        .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
        .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(users, eq(users.id, sales.createdBy))
        .where(eq(sales.id, sale.id))
        .limit(1),
    ]);
    const extra = extras[0];
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const seeContact = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const receiptPath = `/r/${sale.receiptToken}`;
    const message = `Receipt ${sale.saleNumber ?? ""} from ${extra?.businessName ?? ""}. View it here: `;
    return {
      ...this.summaryOf(sale),
      customerName: extra?.customerName ?? null,
      customerPhoneLast4: extra?.customerPhone ? extra.customerPhone.slice(-4) : null,
      byName: extra?.byName ?? null,
      branchName: extra?.branchName ?? null,
      businessName: extra?.businessName ?? null,
      note: sale.note,
      voidReason: sale.voidReason,
      receiptPath,
      // The web app adds its own origin to the link. A customer's number is used only for people who may see it.
      whatsApp: {
        text: message,
        phone: seeContact && extra?.customerPhone ? extra.customerPhone : null,
        hrefPrefix: seeContact && extra?.customerPhone ? whatsAppHref(extra.customerPhone, "") : "https://wa.me/",
      },
      lines: lines.map((line) => ({
        productId: line.productId,
        description: line.description,
        quantity: line.quantity.toString(),
        enteredQuantity: line.enteredQuantity.toString(),
        enteredUnit: line.enteredUnit,
        unitPriceMinor: line.unitPriceMinor.toString(),
        discountMinor: line.discountMinor.toString(),
        lineTotalMinor: line.lineTotalMinor.toString(),
        ...(seeCost && line.costMinor !== null ? { costMinor: line.costMinor.toString() } : {}),
      })),
      payments: payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor.toString(), reference: payment.reference })),
    };
  }

  /** What anyone with the receipt link may see: the receipt, nothing else about the shop or customer. */
  async publicReceipt(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [row] = await this.db
      .select({ sale: sales, businessName: businesses.name, branchName: branches.name, customerName: customers.name })
      .from(sales)
      .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
      .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .where(eq(sales.receiptToken, token))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [lines, payments] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, row.sale.tenantId), eq(saleLines.saleId, row.sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, row.sale.tenantId), eq(salePayments.saleId, row.sale.id))),
    ]);
    return {
      businessName: row.businessName,
      branchName: row.branchName,
      customerName: row.customerName,
      number: row.sale.saleNumber,
      provisionalNumber: row.sale.provisionalNumber,
      status: row.sale.status,
      soldAt: row.sale.soldAt,
      currency: row.sale.currencyCode.trim(),
      subtotalMinor: row.sale.subtotalMinor.toString(),
      discountMinor: row.sale.discountMinor.toString(),
      totalMinor: row.sale.totalMinor.toString(),
      paidMinor: row.sale.paidMinor.toString(),
      balanceMinor: row.sale.balanceMinor.toString(),
      lines: lines.map((line) => ({
        description: line.description,
        enteredQuantity: line.enteredQuantity.toString(),
        enteredUnit: line.enteredUnit,
        unitPriceMinor: line.unitPriceMinor.toString(),
        lineTotalMinor: line.lineTotalMinor.toString(),
      })),
      payments: payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor.toString() })),
    };
  }

  // Helpers -----------------------------------------------------------------------------------------------------------

  /** Prices each line from the product (or the price typed), checks discounts, and converts to base units. */
  private async priceLines(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, payload: SaleCreateInput) {
    const ids = [...new Set(payload.lines.map((line) => line.productId))];
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), inArray(products.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const units = await productUnitsFor(tx, tenant.tenantId, ids);
    const canDiscount = tenant.permissions.includes(Permission.SALES_DISCOUNT);
    return payload.lines.map((line, index) => {
      const product = byId.get(line.productId);
      if (!product || product.archivedAt) {
        throw new ApiError("PRODUCT_NOT_FOUND", "A product in this sale was not found.", 404, [{ field: `lines.${index}.productId`, message: "Not found." }]);
      }
      const productUnits = units.get(product.id) ?? [];
      const factor = unitFactor(product, productUnits, line.unit);
      const entered = parseQuantity(line.quantity) as bigint;
      const quantity = round(entered * factor, 1000n);
      if (quantity <= 0n) throw new ApiError("VALIDATION_ERROR", "Enter a larger quantity.", 400, [{ field: `lines.${index}.quantity`, message: "Too small." }]);
      const pack = productUnits.find((unit) => unit.unitCode === line.unit);
      const listPrice =
        line.unit === product.baseUnit ? product.priceMinor : (pack?.priceMinor ?? (product.priceMinor !== null ? round(product.priceMinor * factor, 1000n) : null));
      const unitPrice = line.unitPriceMinor !== undefined ? BigInt(line.unitPriceMinor) : listPrice;
      if (unitPrice === null) {
        throw new ApiError("PRICE_REQUIRED", `Enter a price for ${product.name}.`, 400, [{ field: `lines.${index}.unitPriceMinor`, message: "Price needed." }]);
      }
      if (listPrice !== null && unitPrice < listPrice && !canDiscount) {
        throw new ApiError("FORBIDDEN", `Ask a manager to sell ${product.name} below its price.`, 403, [{ field: `lines.${index}.unitPriceMinor`, message: "Below the price." }]);
      }
      const lineTotal = round(unitPrice * entered, 1000n);
      const reduction = listPrice !== null && unitPrice < listPrice ? round((listPrice - unitPrice) * entered, 1000n) : 0n;
      return { product, unit: line.unit, entered, quantity, unitPrice, lineTotal, reduction, description: product.name };
    });
  }

  private async insertLines(
    tx: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    saleId: string,
    lines: { product: ProductRow | null; description: string; quantity: bigint; entered: bigint; unit: string; unitPrice: bigint; lineTotal: bigint; reduction?: bigint }[],
    movements: { lineIndex: number; id: string; cost: bigint }[],
  ) {
    await tx.insert(saleLines).values(
      lines.map((line, index) => {
        const movement = movements.find((item) => item.lineIndex === index);
        return {
          id: newId(),
          tenantId: tenant.tenantId,
          businessId,
          saleId,
          lineNo: index + 1,
          productId: line.product?.id ?? null,
          description: line.description.slice(0, 160),
          quantity: line.quantity,
          enteredQuantity: line.entered,
          enteredUnit: line.unit,
          unitPriceMinor: line.unitPrice,
          discountMinor: line.reduction ?? 0n,
          lineTotalMinor: line.lineTotal,
          costMinor: movement?.cost ?? null,
          stockMovementId: movement?.id ?? null,
        };
      }),
    );
  }

  private soldAt(value: string | undefined, allowOlder = false) {
    if (!value) return new Date();
    const date = new Date(value);
    const now = Date.now();
    if (date.getTime() > now + 5 * 60_000) throw new ApiError("VALIDATION_ERROR", "The sale time is in the future. Check the phone's clock.", 400, [{ field: "soldAt", message: "In the future." }]);
    if (!allowOlder && date.getTime() < now - SEVEN_DAYS_MS) {
      throw new ApiError("TOO_OLD", "Sales older than 7 days can only be imported as history.", 400, [{ field: "soldAt", message: "Too old." }]);
    }
    return date;
  }

  private day(business: BusinessRow, date?: string) {
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate(new Date(), business.timezone);
    const start = zonedDateTime(target, "00:00:00", business.timezone);
    return { date: target, start, end: new Date(start.getTime() + 86_400_000) };
  }

  /** Sales this person may see: their shop, and only their own unless they can see all sales. */
  private scope(tenant: TenantContext, businessId: string): SQL[] {
    const filters: SQL[] = [eq(sales.tenantId, tenant.tenantId), eq(sales.businessId, businessId)];
    if (tenant.membershipBranchId) filters.push(eq(sales.branchId, tenant.membershipBranchId));
    if (!tenant.permissions.includes(Permission.SALES_READ_ALL)) filters.push(eq(sales.membershipId, tenant.membershipId));
    return filters;
  }

  private async requireSale(executor: DbExecutor, tenant: TenantContext, id: string): Promise<SaleRow> {
    const business = await requireBusiness(executor, tenant);
    const [sale] = await executor.select().from(sales).where(and(...this.scope(tenant, business.id), eq(sales.id, id))).limit(1);
    if (!sale) throw new ApiError("NOT_FOUND", "Sale not found.", 404);
    return sale;
  }

  private async requireCustomer(tx: DbExecutor, tenant: TenantContext, businessId: string, customerId: string) {
    const filters = [eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, businessId), eq(customers.id, customerId)];
    const [customer] = await tx.select({ id: customers.id }).from(customers).where(and(...filters)).limit(1);
    if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404, [{ field: "customerId", message: "Not found." }]);
    return customer.id;
  }

  private summaryOf(sale: SaleRow) {
    return {
      id: sale.id,
      number: sale.saleNumber,
      provisionalNumber: sale.provisionalNumber,
      externalRef: sale.externalRef,
      status: sale.status,
      historyOnly: sale.historyOnly,
      source: sale.source,
      currency: sale.currencyCode.trim(),
      subtotalMinor: sale.subtotalMinor.toString(),
      discountMinor: sale.discountMinor.toString(),
      totalMinor: sale.totalMinor.toString(),
      paidMinor: sale.paidMinor.toString(),
      balanceMinor: sale.balanceMinor.toString(),
      soldAt: sale.soldAt,
      customerId: sale.customerId,
    };
  }
}
