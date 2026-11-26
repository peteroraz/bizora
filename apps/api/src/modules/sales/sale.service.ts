import { z } from "zod";
import { customerPath, handleOf } from "../../common/handles.js";
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  quantityToString,
  businessTypeFromIndustry,
  formatAddressDisplay,
  parseQuantity,
  capitaliseFirst,
  FLEXIBLE_UNIT,
  Permission,
  ROLE_PERMISSIONS,
  SALE_PAGE_SIZE,
  SALE_STATUSES,
  saleCollectSchema,
  saleCommentSchema,
  saleCreateSchema,
  saleReleaseSchema,
  saleVoidSchema,
  UNIT_CODES,
  whatsAppHref,
  type SaleCreateInput,
  type SaleStatus,
  compactItemKey,
  savedItemKey,
  TYPED_ITEM_NAME_MAX,
  sellsTyped,
  isAmountLine,
} from "@bizora/contracts";
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { addresses, branches, businesses, businessUnits, customerPayments, customers, idempotencyKeys, itemAliases, paymentAllocations, memberships, products, saleComments, saleLines, salePayments, saleReturns, sales, savedItems, stockBalances, syncProblems, users } from "../../db/schema.js";
import { closeProductKey } from "./near-name.js";
import { bankCheckers, transferWaits } from "../money/transfer-rules.js";
import { ReturnService } from "./return.service.js";
import { APP_ENV, DB, EMAIL } from "../../tokens.js";
import { publicWebOrigin, type AppEnv } from "@bizora/config/env";
import type { EmailPort } from "../email/email.port.js";
import { renderEmail } from "../email/templates.js";
import { choosePriceList, listPrices, tierPrice } from "../pricing/price-selection.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { findBranch, productUnitsFor, requireBusiness, resolveBranch, unitFactor, type BusinessRow, type ProductRow, type ProductUnitRow } from "../inventory/inventory-scope.js";
import { StockService } from "../inventory/stock.service.js";
import { SerialService } from "../inventory/serial.service.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { BrandingService } from "../branding/branding.service.js";
import { availableDocuments, documentModel, renderPdf, type DocumentInput, type SaleDocumentType } from "./sale-document.js";

/** A customer's saved address, as one line for documents. */
const customerAddresses = aliasedTable(addresses, "customer_address");
const addressText = (address: typeof addresses.$inferSelect | null) =>
  address
    ? formatAddressDisplay({
        shopNumber: address.shopNumber,
        lineOrBlock: address.lineOrBlock,
        marketOrPlaza: address.marketOrPlaza,
        line1: address.line1,
        city: address.city,
        subdivisionName: null,
      }) || null
    : null;

type SaleRow = typeof sales.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type BranchRow = typeof branches.$inferSelect;
export type SaleSource = "pos" | "offline" | "import" | "capture";
type Payment = { method: "cash" | "transfer" | "pos"; amountMinor: string; reference?: string | undefined };

const SEVEN_DAYS_MS = 7 * 86_400_000;

const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);

type ProblemLine = { productId?: string; description?: string; quantity?: string; unit?: string; amountMinor?: string };

/** What an amount-only line is called on receipts and lists when the seller did not say what it was for (ADR-069). */
const AMOUNT_LINE_NAME = "Sale";

/**
 * What a goods line cost, or null when nobody has said (ADR-049 addendum, 26 Nov). Stock added without a cost leaves
 * the shelf at ₦0. That is "no cost recorded", not free goods, so profit must not count it as known. An owner who
 * really gets goods free sets the product's cost to 0, and then ₦0 is a known cost.
 */
export function knownLineCost(costMinor: bigint, product: Pick<ProductRow, "defaultCostMinor">): bigint | null {
  return costMinor === 0n && product.defaultCostMinor === null ? null : costMinor;
}

function problemLines(payload: Record<string, unknown>): ProblemLine[] {
  return Array.isArray(payload.lines) ? (payload.lines as ProblemLine[]) : [];
}

function problemSummary(payload: Record<string, unknown>, names: Map<string, string>) {
  const parts = problemLines(payload).map((line) => {
    const name = line.description?.trim() || (line.productId ? names.get(line.productId) : undefined) || (line.amountMinor ? AMOUNT_LINE_NAME : "A product");
    return [line.quantity, line.unit, name].filter(Boolean).join(" ");
  });
  return parts.join(", ") || "A sale";
}

function problemTotal(payload: Record<string, unknown>) {
  const payments = Array.isArray(payload.payments) ? (payload.payments as { amountMinor?: string }[]) : [];
  return payments.reduce((sum, payment) => sum + (payment.amountMinor && /^\d+$/.test(payment.amountMinor) ? BigInt(payment.amountMinor) : 0n), 0n).toString();
}

/** "Rice 50kg is sold by the bag. Choose bag." One unit, or "the bag or carton" when there are two. */
function soldBy(name: string, units: string[]) {
  const unique = [...new Set(units)];
  if (unique.length <= 1) {
    const unit = unique[0] ?? "piece";
    return `${name} is sold by the ${unit}. Choose ${unit}.`;
  }
  const last = unique[unique.length - 1];
  return `${name} is sold by the ${unique.slice(0, -1).join(", ")} or ${last}. Choose one of those.`;
}

/** Job functions that give out goods but do not see every sale: they are told when goods are ready (store keepers). */
const RELEASE_ROLES = Object.entries(ROLE_PERMISSIONS)
  .filter(([, permissions]) => permissions.includes(Permission.SALES_RELEASE) && !permissions.includes(Permission.SALES_READ_ALL))
  .map(([role]) => role);

/**
 * Sales (ADR-015, ADR-016).
 *
 * Simple flow: one transaction records the sale, takes the money (or gives credit), takes stock out and posts it all.
 * Desk flow: the sales person records the sale (awaiting_payment); the cashier takes the money or gives credit, which
 * posts the money and revenue (awaiting_release); the store keeper gives out the goods, which takes stock out and
 * posts cost of goods (completed). Cancelling at any stage reverses whatever has happened so far.
 */
@Injectable()
export class SaleService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(BrandingService) private readonly branding: BrandingService,
    @Inject(ReturnService) private readonly returns: ReturnService,
    @Inject(SerialService) private readonly serials: SerialService,
    @Inject(EMAIL) private readonly email: EmailPort,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async create(tenant: TenantContext, raw: unknown, options: { source?: SaleSource; soldAt?: Date; allowOlder?: boolean } = {}) {
    const payload = saleCreateSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(sales).where(eq(sales.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const source = options.source ?? "pos";
    const soldAt = options.soldAt ?? this.soldAt(payload.soldAt, options.allowOlder);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await this.branchForSale(tx, tenant, business.id, source);
      // A warehouse keeps stock but does not sell at the counter (ADR-047). Sales already made elsewhere still count.
      if (branch.kind === "warehouse" && source === "pos") {
        throw new ApiError("WAREHOUSE_NO_SALES", `${branch.name} is a warehouse. Choose a shop to sell from, or move the stock to a shop first.`, 409);
      }
      const customer = payload.customerId ? await this.requireCustomer(tx, tenant, business.id, payload.customerId) : null;
      // A price list: chosen at the counter, or the customer's (ADR-048).
      const priceList = await choosePriceList(tx, tenant, {
        businessId: business.id,
        branchId: branch.id,
        currencyCode: business.baseCurrencyCode,
        chosenId: payload.priceListId,
        customerListId: customer?.priceListId ?? null,
        live: source === "pos",
      });
      const priced = await this.priceLines(
        tx,
        tenant,
        business,
        payload,
        priceList ? { id: priceList.id, day: localDate(soldAt, business.timezone) } : null,
        source === "pos",
        source === "offline",
      );
      const lines = priced.lines;
      // Typed items need the shop to allow them (ADR-041). A sale made offline is kept: the phone allowed it then.
      const typedAt = lines.findIndex((line) => line.saved);
      if (typedAt >= 0 && source === "pos" && !sellsTyped(business.salesItems)) {
        throw new ApiError("TYPED_ITEMS_OFF", "This shop sells only products from its list. The owner can allow typed items in Settings.", 403, [
          { field: `lines.${typedAt}.description`, message: "Choose a product from the list." },
        ]);
      }
      if (typedAt >= 0 && source === "pos" && !tenant.permissions.includes(Permission.CATALOG_QUICK_CREATE)) {
        throw new ApiError("FORBIDDEN", "Adding a new item is turned off for your job. Choose one from the list.", 403, [
          { field: `lines.${typedAt}.description`, message: "Choose an item from the list." },
        ]);
      }
      // Imports are past records, so they are never sent to a cashier.
      const desk = business.salesFlow === "desk" && source !== "import" && source !== "capture";

      const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0n);
      // Services and other income; typed items and amounts are goods and count as sales (ADR-041, ADR-069).
      const otherSubtotal = lines.reduce((sum, line) => sum + (line.other && !line.saved && !("amount" in line && line.amount) ? line.lineTotal : 0n), 0n);
      const discount = payload.discountMinor ? BigInt(payload.discountMinor) : 0n;
      if (discount > 0n && !tenant.permissions.includes(Permission.SALES_DISCOUNT)) {
        throw new ApiError("FORBIDDEN", "Ask a manager to give a discount.", 403, [{ field: "discountMinor", message: "Remove the discount." }]);
      }
      if (discount > subtotal) throw new ApiError("VALIDATION_ERROR", "The discount is more than the sale.", 400, [{ field: "discountMinor", message: "Too large." }]);
      const total = subtotal - discount;
      if (desk && payload.payments.length > 0) {
        throw new ApiError("PAY_AT_CASHIER", "In this shop the cashier takes payment. Send the sale to the cashier.", 400, [{ field: "payments", message: "Leave empty." }]);
      }
      // In the desk flow the goods leave later; check now that they are on the shelf before anyone pays.
      if (desk && source === "pos") await this.assertOnShelf(tx, tenant, branch, lines.map((line) => ({ product: line.product, quantity: line.quantity })));

      // Desk: the customer takes an invoice to the cashier; the receipt number comes with the payment (ADR-017).
      const receiptNumber = desk ? null : (await this.numbers.next(tx, tenant.tenantId, business.id, "receipt")).number;
      const now = new Date();
      onTerms(payload, customer, total, business.timezone);
      const settled = desk
        ? null
        : await this.settle(tx, tenant, business, branch, {
            id,
            number: receiptNumber ?? "",
            subtotal,
            otherSubtotal,
            discount,
            total,
            entryDate: localDate(soldAt, business.timezone),
            payments: payload.payments,
            customer,
            dueDate: payload.dueDate,
            comment: payload.comment,
            source,
          });

      await tx.insert(sales).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        customerId: customer?.id ?? null,
        priceListId: priceList?.id ?? null,
        saleNumber: receiptNumber,
        invoiceNumber: desk || (settled && settled.balance > 0n) ? (await this.numbers.next(tx, tenant.tenantId, business.id, "invoice")).number : null,
        provisionalNumber: payload.provisionalNumber ?? null,
        status: desk ? "awaiting_payment" : "completed",
        historyOnly: false,
        source,
        currencyCode: business.baseCurrencyCode.trim(),
        subtotalMinor: subtotal,
        discountMinor: discount,
        totalMinor: total,
        paidMinor: settled?.paid ?? 0n,
        balanceMinor: settled?.balance ?? total,
        note: payload.note ?? null,
        receiptToken: randomBytes(24).toString("base64url"),
        journalEntryId: settled?.journalEntryId ?? null,
        soldAt,
        requestedPayment: payload.requestedPayment ?? null,
        dueDate: settled && settled.balance > 0n ? (payload.dueDate ?? null) : null,
        ...(desk
          ? {}
          : {
              // An offline sale was paid and handed over on the phone, when it was made.
              collectedAt: source === "offline" ? soldAt : now,
              collectedBy: tenant.userId,
              collectedMembershipId: tenant.membershipId,
              releasedAt: source === "offline" ? soldAt : now,
              releasedBy: tenant.userId,
              releasedMembershipId: tenant.membershipId,
            }),
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
        actorType: tenant.actorType ?? "HUMAN",
      });
      await this.insertLines(tx, tenant, business.id, id, lines, []);
      // Serial numbers or IMEIs of the units sold (ADR-062).
      const serialsByLine = new Map(
        payload.lines.flatMap((line, index) => ("serials" in line && line.serials?.length ? [[index + 1, line.serials] as [number, string[]]] : [])),
      );
      await this.serials.sellNewSale(tx, tenant, { businessId: business.id, branchId: branch.id, saleId: id, customerId: customer?.id ?? null, soldAt, live: source === "pos" }, serialsByLine);
      if (typedAt >= 0) await this.rememberTyped(tx, tenant, business.id, lines, soldAt, payload.itemSource === "voice" ? "voice" : "typed", business.rememberItems);
      if (settled) {
        await this.insertPayments(tx, tenant, business.id, id, payload.payments, settled.transfersWait);
        if (settled.transfersWait) await this.askToCheckTransfer(tx, tenant, business.id, id);
        await this.takeStock(tx, tenant, business, branch, id, receiptNumber ?? "", soldAt, source);
      }
      const creditNote = payload.comment ?? (source === "offline" && settled && settled.balance > 0n ? "Sold offline" : undefined);
      if (creditNote) await this.addComment(tx, tenant, business.id, id, creditNote, settled && settled.balance > 0n ? "credit" : "comment");
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
          metadata: { number: receiptNumber, totalMinor: total.toString(), source, stage: desk ? "awaiting_payment" : "completed", ...(settled?.overLimit ? { overCreditLimit: true } : {}) },
        },
        tx,
      );
      if (priced.belowPrice.length > 0) await this.flagBelowPrice(tx, tenant, business.id, branch.id, id, priced.belowPrice);
      if (priced.likeProduct.length > 0) await this.flagTypedLikeProduct(tx, tenant, business.id, branch.id, id, priced.likeProduct);
      if (settled?.creditOffline) await this.flagCreditOffline(tx, tenant, business.id, branch.id, id, settled.creditOffline);
      if (source === "offline" && branch.closedAt) await this.flagClosedShop(tx, tenant, business.id, branch.id, id, branch.name);
    });
    // The sale is in the shop it was made in. A person moved off that shop (it has since closed) can still be given
    // the sale they just recorded. Their usual list stays limited to the shop they work in now.
    const movedOff = source === "offline" && Boolean(tenant.membershipBranchId) && tenant.branchId !== tenant.membershipBranchId;
    return this.get(movedOff ? { ...tenant, membershipBranchId: null } : tenant, id);
  }

  /**
   * A finished job becomes a sale (ADR-035). Its parts already left stock when they went on the job, so no stock
   * moves here: their cost and the helpers' pay move from "Jobs in progress" to cost of sales. Work done earns service
   * income, parts earn sales. Deposits taken on the job are taken off the bill; the rest is owed by the customer.
   */
  async recordJobBill(
    tx: DbExecutor,
    tenant: TenantContext,
    input: {
      business: BusinessRow;
      branch: BranchRow;
      customer: CustomerRow;
      job: { id: string; number: string; title: string | null };
      lines: { kind: "work" | "part" | "bought"; productId: string | null; description: string; quantity: bigint; entered: bigint; unit: string; unitPrice: bigint; lineTotal: bigint; cost: bigint; stockMovementId: string | null }[];
      costTotal: bigint;
      deposits: { id: string; amount: bigint }[];
      soldAt: Date;
      dueDate: string | null;
    },
  ) {
    const { business, branch, customer } = input;
    const id = newId();
    const total = input.lines.reduce((sum, line) => sum + line.lineTotal, 0n);
    const work = input.lines.reduce((sum, line) => sum + (line.kind === "work" ? line.lineTotal : 0n), 0n);
    const deposited = input.deposits.reduce((sum, deposit) => sum + deposit.amount, 0n);
    if (deposited > total) {
      throw new ApiError("DEPOSIT_MORE_THAN_BILL", "The deposits are more than this job's bill. Add the missing work or parts, or give the customer the difference back first.", 409);
    }
    const balance = total - deposited;
    const number = (await this.numbers.next(tx, tenant.tenantId, business.id, "receipt")).number;
    const invoiceNumber = balance > 0n ? (await this.numbers.next(tx, tenant.tenantId, business.id, "invoice")).number : null;
    const goodsIncome = businessTypeFromIndustry(business.industryCode) === "services" ? "service_income" : "sales";
    const posting: PostingLine[] = [];
    if (balance > 0n) posting.push({ account: { role: "debtors" }, debitMinor: balance, memo: customer.name });
    if (deposited > 0n) posting.push({ account: { role: "customer_deposits" }, debitMinor: deposited, memo: input.job.number });
    if (total - work > 0n) posting.push({ account: { role: goodsIncome }, creditMinor: total - work, memo: "Parts" });
    if (work > 0n) posting.push({ account: { role: "service_income" }, creditMinor: work, memo: "Work done" });
    if (input.costTotal > 0n) {
      posting.push({ account: { role: "cogs" }, debitMinor: input.costTotal, memo: input.job.number });
      posting.push({ account: { role: "jobs_in_progress" }, creditMinor: input.costTotal, memo: input.job.number });
    }
    let journalEntryId: string | null = null;
    if (posting.length >= 2) {
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: localDate(input.soldAt, business.timezone),
          source: { type: "sale", id },
          postingKey: `sale:${id}`,
          description: `Job ${input.job.number} for ${customer.name}`,
          lines: posting,
        },
      );
      journalEntryId = posted.entryId;
    }
    const now = new Date();
    await tx.insert(sales).values({
      id,
      tenantId: tenant.tenantId,
      businessId: business.id,
      branchId: branch.id,
      customerId: customer.id,
      saleNumber: number,
      invoiceNumber,
      status: "completed",
      historyOnly: false,
      source: "job",
      currencyCode: business.baseCurrencyCode.trim(),
      subtotalMinor: total,
      discountMinor: 0n,
      totalMinor: total,
      paidMinor: deposited,
      balanceMinor: balance,
      note: `${input.job.number}${input.job.title ? `: ${input.job.title}` : ""}`.slice(0, 240),
      receiptToken: randomBytes(24).toString("base64url"),
      journalEntryId,
      soldAt: input.soldAt,
      dueDate: balance > 0n ? input.dueDate : null,
      collectedAt: now,
      collectedBy: tenant.userId,
      collectedMembershipId: tenant.membershipId,
      releasedAt: now,
      releasedBy: tenant.userId,
      releasedMembershipId: tenant.membershipId,
      createdBy: tenant.userId,
      membershipId: tenant.membershipId,
      deviceId: tenant.deviceId ?? null,
      actorType: tenant.actorType ?? "HUMAN",
    });
    if (input.lines.length > 0) {
      await this.insertLines(
        tx,
        tenant,
        business.id,
        id,
        input.lines.map((line) => ({ product: line.productId ? ({ id: line.productId } as ProductRow) : null, description: line.description, quantity: line.quantity, entered: line.entered, unit: line.unit, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
        input.lines.flatMap((line, index) => (line.stockMovementId ? [{ lineIndex: index, id: line.stockMovementId, cost: line.cost }] : [])),
      );
    }
    for (const deposit of input.deposits) {
      await tx.insert(paymentAllocations).values({ id: newId(), tenantId: tenant.tenantId, paymentId: deposit.id, saleId: id, amountMinor: deposit.amount });
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
        metadata: { number, totalMinor: total.toString(), source: "job", job: input.job.number, depositsMinor: deposited.toString() },
      },
      tx,
    );
    return { saleId: id, number, invoiceNumber, total, balance };
  }

  /** The cashier takes the money, or gives credit to an approved customer, for a sale from the sales desk. */
  async collect(tenant: TenantContext, id: string, raw: unknown) {
    const payload = saleCollectSchema.parse(raw ?? {});
    await this.db.transaction(async (tx) => {
      const sale = await this.requireSale(tx, tenant, id, true);
      if (sale.status !== "awaiting_payment") throw new ApiError("NOT_AWAITING_PAYMENT", "This sale is not waiting for payment.", 409);
      const business = await requireBusiness(tx, tenant);
      const branch = await findBranch(tx, tenant, business.id, sale.branchId);
      // Before taking money, check the goods are still on the shelf (someone may have sold them since).
      if (sale.source === "pos") {
        const saleItems = await tx.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id)));
        const productIds = [...new Set(saleItems.map((line) => line.productId).filter((value): value is string => Boolean(value)))];
        const productRows = productIds.length ? await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, productIds))) : [];
        const byId = new Map(productRows.map((row) => [row.id, row]));
        await this.assertOnShelf(tx, tenant, branch, saleItems.map((line) => ({ product: line.productId ? (byId.get(line.productId) ?? null) : null, quantity: line.quantity })));
      }
      const customerId = payload.customerId ?? sale.customerId;
      const customer = customerId ? await this.requireCustomer(tx, tenant, business.id, customerId) : null;
      const now = new Date();
      const receiptNumber = sale.saleNumber ?? (await this.numbers.next(tx, tenant.tenantId, business.id, "receipt")).number;
      onTerms(payload, customer, sale.totalMinor, business.timezone);
      const otherLines = await tx
        .select({ total: saleLines.lineTotalMinor })
        .from(saleLines)
        .where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id), isNull(saleLines.productId)));
      const settled = await this.settle(tx, tenant, business, branch, {
        id: sale.id,
        number: receiptNumber,
        subtotal: sale.subtotalMinor,
        otherSubtotal: otherLines.reduce((sum, line) => sum + line.total, 0n),
        discount: sale.discountMinor,
        total: sale.totalMinor,
        entryDate: localDate(now, business.timezone),
        payments: payload.payments,
        customer,
        dueDate: payload.dueDate,
        comment: payload.comment,
        source: sale.source as SaleSource,
      });
      await tx
        .update(sales)
        .set({
          status: "awaiting_release",
          saleNumber: receiptNumber,
          ...(settled.balance > 0n && !sale.invoiceNumber ? { invoiceNumber: (await this.numbers.next(tx, tenant.tenantId, business.id, "invoice")).number } : {}),
          customerId: customer?.id ?? null,
          paidMinor: settled.paid,
          balanceMinor: settled.balance,
          dueDate: settled.balance > 0n ? (payload.dueDate ?? null) : null,
          journalEntryId: settled.journalEntryId,
          collectedAt: now,
          collectedBy: tenant.userId,
          collectedMembershipId: tenant.membershipId,
        })
        .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, sale.id)));
      await this.insertPayments(tx, tenant, business.id, sale.id, payload.payments, settled.transfersWait);
      if (settled.transfersWait) await this.askToCheckTransfer(tx, tenant, business.id, sale.id);
      if (payload.comment) await this.addComment(tx, tenant, business.id, sale.id, payload.comment, settled.balance > 0n ? "credit" : "comment");
      const storeKeepers = await this.storeKeepers(tx, tenant.tenantId, business.id, sale.branchId);
      await this.notifications.notify(tx, tenant.tenantId, [sale.membershipId, ...storeKeepers], {
        kind: settled.balance > 0n ? "sale.credit" : "sale.paid",
        saleId: sale.id,
        actorName: await this.actorName(tx, tenant),
        except: tenant.membershipId,
      });
      await this.record(tx, tenant, sale, "sale.collected", {
        paidMinor: settled.paid.toString(),
        balanceMinor: settled.balance.toString(),
        ...(settled.overLimit ? { overCreditLimit: true } : {}),
      });
    });
    return this.get(tenant, id);
  }

  /** The store keeper gives out the goods. Stock leaves the shop now, at weighted-average cost. */
  async release(tenant: TenantContext, id: string, raw: unknown) {
    const payload = saleReleaseSchema.parse(raw ?? {});
    await this.db.transaction(async (tx) => {
      const sale = await this.requireSale(tx, tenant, id, true);
      if (sale.status !== "awaiting_release") {
        throw new ApiError("NOT_READY_FOR_RELEASE", sale.status === "awaiting_payment" ? "The cashier has not taken payment for this sale yet." : "This sale is not waiting for goods to be given out.", 409);
      }
      const business = await requireBusiness(tx, tenant);
      const branch = await findBranch(tx, tenant, business.id, sale.branchId);
      const now = new Date();
      await this.takeStock(tx, tenant, business, branch, sale.id, sale.saleNumber ?? sale.invoiceNumber ?? "", now, sale.source);
      await tx
        .update(sales)
        .set({ status: "completed", releasedAt: now, releasedBy: tenant.userId, releasedMembershipId: tenant.membershipId })
        .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, sale.id)));
      if (payload.comment) await this.addComment(tx, tenant, business.id, sale.id, payload.comment, "comment");
      await this.notifications.notify(tx, tenant.tenantId, [sale.membershipId, sale.collectedMembershipId], {
        kind: "sale.released",
        saleId: sale.id,
        actorName: await this.actorName(tx, tenant),
        except: tenant.membershipId,
      });
      await this.record(tx, tenant, sale, "sale.released", {});
    });
    return this.get(tenant, id);
  }

  /** Comments from the sales person, cashier and store keeper. Anyone who can see the sale can add one. */
  async comment(tenant: TenantContext, id: string, raw: unknown) {
    const { body } = saleCommentSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const sale = await this.requireSale(tx, tenant, id);
      await this.addComment(tx, tenant, sale.businessId, sale.id, body, "comment");
      await this.notifications.notify(tx, tenant.tenantId, [sale.membershipId, sale.collectedMembershipId, sale.releasedMembershipId], {
        kind: "sale.comment",
        saleId: sale.id,
        actorName: await this.actorName(tx, tenant),
        except: tenant.membershipId,
      });
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
      const sale = await this.requireSale(tx, tenant, id, true);
      if (sale.status === "voided") throw new ApiError("ALREADY_VOIDED", "This sale has already been cancelled.", 409);
      // A sales person may cancel their own sale while it still waits for payment; nothing has happened yet.
      const ownUnpaid = sale.status === "awaiting_payment" && sale.membershipId === tenant.membershipId;
      if (!tenant.permissions.includes(Permission.SALES_VOID) && !ownUnpaid) {
        throw new ApiError("FORBIDDEN", "Ask a manager to cancel this sale.", 403);
      }
      // Payments made later against this sale must be cancelled first, so the money is not counted twice (ADR-019).
      const [paidLater] = await tx
        .select({ number: customerPayments.paymentNumber })
        .from(paymentAllocations)
        .innerJoin(customerPayments, and(eq(customerPayments.tenantId, paymentAllocations.tenantId), eq(customerPayments.id, paymentAllocations.paymentId)))
        .where(and(eq(paymentAllocations.tenantId, tenant.tenantId), eq(paymentAllocations.saleId, sale.id), eq(customerPayments.status, "recorded")))
        .limit(1);
      if (paidLater) throw new ApiError("HAS_PAYMENTS", `Payment ${paidLater.number} was made against this sale. Cancel that payment first.`, 409);
      // Goods already came back (ADR-030): the return stands, so the sale cannot be undone as a whole.
      if (sale.returnedMinor > 0n || (await tx.select({ id: saleReturns.id }).from(saleReturns).where(and(eq(saleReturns.tenantId, tenant.tenantId), eq(saleReturns.saleId, sale.id))).limit(1)).length > 0) {
        throw new ApiError("HAS_RETURNS", "Goods were returned from this sale, so it can no longer be cancelled. Return the rest of the goods instead.", 409);
      }
      const business = await requireBusiness(tx, tenant);
      const today = localDate(new Date(), business.timezone);
      // Transfers already checked (ADR-031): undo the check too, so the money comes back out of the bank (or out of
      // what the customer owes, or out of the loss). One matched to a bank statement is unmatched there first.
      const checked = await tx
        .select({ entryId: salePayments.confirmationEntryId, via: salePayments.confirmedVia })
        .from(salePayments)
        .where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.saleId, sale.id), isNotNull(salePayments.confirmationEntryId)));
      if (checked.some((payment) => payment.via === "bank_statement")) {
        throw new ApiError("MATCHED_TO_BANK", "A transfer on this sale is matched to a bank statement line. Unmatch it in Bank first.", 409);
      }
      if (!sale.historyOnly && sale.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, sale.journalEntryId, { entryDate: today, reason: `Sale ${sale.saleNumber ?? sale.invoiceNumber} cancelled: ${reason}` });
      }
      for (const payment of checked) {
        if (payment.entryId) await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, payment.entryId, { entryDate: today, reason: `Sale ${sale.saleNumber ?? sale.invoiceNumber} cancelled: ${reason}` });
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
            note: sale.saleNumber ?? sale.invoiceNumber,
            valueMinor: line.costMinor ?? 0n,
          });
        }
      }
      await this.serials.releaseSale(tx, tenant, sale.id);
      await tx.update(sales).set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason }).where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, sale.id)));
      await this.notifications.notify(tx, tenant.tenantId, [sale.membershipId, sale.collectedMembershipId], {
        kind: "sale.voided",
        saleId: sale.id,
        actorName: await this.actorName(tx, tenant),
        except: tenant.membershipId,
      });
      await this.record(tx, tenant, sale, "sale.voided", { reason, stage: sale.status });
    });
    return this.get(tenant, id);
  }

  /**
   * Sales for one day, or every sale at one stage (the cashier's and store keeper's lists, oldest first).
   * Store keepers see what to give out, without amounts or customers.
   */
  async list(tenant: TenantContext, query: { date?: string; page?: number; status?: string; customerId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const filters = this.scope(tenant, business.id);
    const status = SALE_STATUSES.find((item) => item === query.status);
    const day = this.day(business, query.date);
    // One customer's purchases (6d): every day, newest first, within what this person may see.
    const customerId = query.customerId && /^[0-9a-f-]{36}$/i.test(query.customerId) ? query.customerId : null;
    if (customerId) filters.push(eq(sales.customerId, customerId));
    else if (status) filters.push(eq(sales.status, status));
    else filters.push(gte(sales.soldAt, day.start), lt(sales.soldAt, day.end));
    const page = Math.max(1, query.page ?? 1);
    const [count] = await this.db.select({ total: sql<number>`count(*)::int` }).from(sales).where(and(...filters));
    const rows = await this.db
      .select({
        sale: sales,
        customerName: customers.name,
        byName: users.displayName,
        itemCount: sql<number>`(SELECT count(*)::int FROM sale_lines WHERE sale_lines.tenant_id = ${sales.tenantId} AND sale_lines.sale_id = ${sales.id})`,
        // How it was paid, for the list rows (6d): "Cash", "Transfer + POS".
        methods: sql<string>`(SELECT coalesce(string_agg(DISTINCT sp.method, ',' ORDER BY sp.method), '') FROM sale_payments sp WHERE sp.tenant_id = ${sales.tenantId} AND sp.sale_id = ${sales.id})`,
      })
      .from(sales)
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(users, eq(users.id, sales.createdBy))
      .where(and(...filters))
      .orderBy(...(status && !customerId ? [asc(sales.createdAt), asc(sales.id)] : [desc(sales.soldAt), desc(sales.id)]))
      .limit(SALE_PAGE_SIZE)
      .offset((page - 1) * SALE_PAGE_SIZE);
    return {
      date: status || customerId ? null : day.date,
      status: status ?? null,
      page,
      pageSize: SALE_PAGE_SIZE,
      total: Number(count?.total ?? 0),
      items: rows.map(({ sale, customerName, byName, itemCount, methods }) =>
        this.viewOf(tenant, sale) === "full"
          ? { ...this.summaryOf(sale), customerName, byName, itemCount: Number(itemCount), methods: methods ? methods.split(",") : [], view: "full" as const }
          : { ...this.releaseSummary(sale), byName, itemCount: Number(itemCount), view: "release" as const },
      ),
    };
  }

  /** How many sales wait at each desk in this shop, for badges and Home. */
  async queues(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const has = (code: string) => tenant.permissions.includes(code as never);
    const base: SQL[] = [eq(sales.tenantId, tenant.tenantId), eq(sales.businessId, business.id)];
    if (tenant.membershipBranchId) base.push(eq(sales.branchId, tenant.membershipBranchId));
    const count = async (...filters: SQL[]) => {
      const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(sales).where(and(...base, ...filters));
      return Number(row?.n ?? 0);
    };
    const all = has(Permission.SALES_READ_ALL);
    return {
      salesFlow: business.salesFlow,
      awaitingPayment: has(Permission.SALES_COLLECT) || all ? await count(eq(sales.status, "awaiting_payment")) : null,
      awaitingRelease: has(Permission.SALES_RELEASE) || all ? await count(eq(sales.status, "awaiting_release")) : null,
      mineWaiting: has(Permission.SALES_CREATE) ? await count(eq(sales.membershipId, tenant.membershipId), inArray(sales.status, ["awaiting_payment", "awaiting_release"])) : null,
    };
  }

  /**
   * Totals for one day: number of sales, money in by method, and what was sold on credit. A sale counts once the
   * money is taken (or credit given); cancelled and waiting-for-payment sales are left out. Without sales.read.all,
   * a person sees the sales they recorded or took payment for.
   */
  async summary(tenant: TenantContext, date?: string) {
    const business = await requireBusiness(this.db, tenant);
    const day = this.day(business, date);
    const when = sql`coalesce(${sales.collectedAt}, ${sales.soldAt})`;
    const filters: SQL[] = [eq(sales.tenantId, tenant.tenantId), eq(sales.businessId, business.id), inArray(sales.status, ["awaiting_release", "completed"]), sql`${when} >= ${day.start.toISOString()}::timestamptz`, sql`${when} < ${day.end.toISOString()}::timestamptz`];
    if (tenant.membershipBranchId) filters.push(eq(sales.branchId, tenant.membershipBranchId));
    const all = tenant.permissions.includes(Permission.SALES_READ_ALL);
    if (!all) filters.push(or(eq(sales.membershipId, tenant.membershipId), eq(sales.collectedMembershipId, tenant.membershipId)) as SQL);
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
      mine: !all,
      count: Number(totals?.count ?? 0),
      totalMinor: BigInt(totals?.total ?? 0).toString(),
      creditMinor: BigInt(totals?.credit ?? 0).toString(),
      byMethod: Object.fromEntries(methods.map((row) => [row.method, BigInt(row.amount).toString()])),
    };
  }

  /**
   * What sold in a period, products and remembered items together (ADR-049).
   * A line with no cost does not get a margin.
   */
  async topItems(tenant: TenantContext, query: { from?: string; to?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const today = this.day(business);
    const from = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : today.date;
    const to = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : from;
    const filters: SQL[] = [
      eq(saleLines.tenantId, tenant.tenantId),
      eq(sales.businessId, business.id),
      inArray(sales.status, ["awaiting_release", "completed"]),
      sql`(${sales.soldAt} AT TIME ZONE ${business.timezone})::date >= ${from}::date`,
      sql`(${sales.soldAt} AT TIME ZONE ${business.timezone})::date <= ${to}::date`,
    ];
    if (tenant.membershipBranchId) filters.push(eq(sales.branchId, tenant.membershipBranchId));
    if (!tenant.permissions.includes(Permission.SALES_READ_ALL)) filters.push(eq(sales.membershipId, tenant.membershipId));
    const rows = await this.db
      .select({
        name: saleLines.description,
        unit: saleLines.enteredUnit,
        kind: saleLines.lineKind,
        salesCount: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${saleLines.lineTotalMinor}), 0)::text`,
        costKnown: sql<boolean>`bool_and(${saleLines.lineKind} = 'service' OR ${saleLines.costMinor} IS NOT NULL)`,
      })
      .from(saleLines)
      .innerJoin(sales, and(eq(sales.tenantId, saleLines.tenantId), eq(sales.id, saleLines.saleId)))
      // Amounts with no item are not items sold (ADR-069).
      .where(and(...filters, sql`${saleLines.lineKind} <> 'amount'`))
      .groupBy(saleLines.description, saleLines.enteredUnit, saleLines.lineKind)
      .orderBy(sql`sum(${saleLines.lineTotalMinor}) DESC`)
      .limit(20);
    return {
      from,
      to,
      currency: business.baseCurrencyCode.trim(),
      items: rows.map((row) => ({
        name: row.name,
        unit: row.unit,
        kind: row.kind,
        salesCount: Number(row.salesCount),
        totalMinor: BigInt(row.total).toString(),
        costKnown: row.kind === "service" ? true : Boolean(row.costKnown),
      })),
    };
  }

  /**
   * Sends the customer a link to their receipt or invoice by email (ADR-042): the same page as the WhatsApp link, never
   * the PDF itself. Only someone who can see the sale may send it; the address is not stored, only its domain is logged.
   */
  async emailReceipt(tenant: TenantContext, id: string, raw: unknown) {
    const { to } = z.object({ to: z.string().trim().toLowerCase().email().max(254) }).parse(raw);
    const sale = await this.get(tenant, id);
    if (sale.view !== "full") throw new ApiError("FORBIDDEN", "Only the full sale can be sent.", 403);
    const rendered = renderEmail({
      title: `Your ${sale.documents.includes("receipt") ? "receipt" : "invoice"} from ${sale.businessName ?? "the shop"}`,
      paragraphs: [`Thank you for buying from ${sale.businessName ?? "us"}. Open the link to see it, or save it as a PDF.`],
      actionLabel: "Open it",
      actionUrl: `${publicWebOrigin(this.env)}${sale.receiptPath}`,
    });
    await this.email.send({ to, subject: `Your ${sale.businessName ?? "Bizora"} receipt`, kind: "receipt", correlationId: tenant.correlationId, ...rendered });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "sale.receipt_emailed",
      entityType: "sale",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: tenant.businessId ?? null,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { toDomain: to.split("@")[1] ?? "" },
    });
    return { sent: true };
  }

  async get(tenant: TenantContext, id: string) {
    const sale = await this.requireSale(this.db, tenant, id);
    const collector = sql<string | null>`(SELECT display_name FROM users WHERE users.id = ${sales.collectedBy})`;
    const releaser = sql<string | null>`(SELECT display_name FROM users WHERE users.id = ${sales.releasedBy})`;
    const [lines, payments, extras, comments, laterPayments] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.saleId, sale.id))).orderBy(asc(salePayments.createdAt)),
      this.db
        .select({
          customer: customers,
          byName: users.displayName,
          branchName: branches.name,
          businessName: businesses.name,
          collectedByName: collector,
          releasedByName: releaser,
        })
        .from(sales)
        .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
        .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(users, eq(users.id, sales.createdBy))
        .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, sale.id)))
        .limit(1),
      this.db
        .select({ comment: saleComments, byName: users.displayName })
        .from(saleComments)
        .leftJoin(users, eq(users.id, saleComments.userId))
        .where(and(eq(saleComments.tenantId, tenant.tenantId), eq(saleComments.saleId, sale.id)))
        .orderBy(asc(saleComments.createdAt), asc(saleComments.id)),
      this.laterPayments(sale),
    ]);
    const extra = extras[0];
    // The sale's returns, and how much of each line has come back in the unit it was sold in (ADR-030).
    const returned = await this.returns.forSale(this.db, tenant.tenantId, sale.id, lines.map((line) => line.id));
    const returnedByLine = returned.returnedByLine;
    const stages = {
      /** Whether this person recorded the sale (they may cancel it while it waits for payment). */
      mine: sale.membershipId === tenant.membershipId,
      requestedPayment: sale.requestedPayment,
      collectedAt: sale.collectedAt,
      collectedByName: extra?.collectedByName ?? null,
      releasedAt: sale.releasedAt,
      releasedByName: extra?.releasedByName ?? null,
      byName: extra?.byName ?? null,
      branchName: extra?.branchName ?? null,
      comments: comments.map(({ comment, byName }) => ({ id: comment.id, kind: comment.kind, role: comment.role, body: comment.body, byName, createdAt: comment.createdAt })),
    };
    if (this.viewOf(tenant, sale) === "release") {
      return {
        ...this.releaseSummary(sale),
        ...stages,
        view: "release" as const,
        lines: lines.map((line) => ({ description: line.description, enteredQuantity: line.enteredQuantity.toString(), enteredUnit: line.enteredUnit })),
      };
    }
    const customer = extra?.customer ?? null;
    const possibleById = await this.possibleProducts(tenant.tenantId, sale.source, lines);
    const serialsByLine = await this.serials.ofLines(this.db, tenant.tenantId, lines.map((line) => line.id));
    const lineProductIds = [...new Set(lines.flatMap((line) => (line.productId ? [line.productId] : [])))];
    const keepsSerials = new Set(
      lineProductIds.length
        ? (await this.db.select({ id: products.id }).from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, lineProductIds), eq(products.tracksSerials, true)))).map((row) => row.id)
        : [],
    );
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const seeContact = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const receiptPath = customerPath(await handleOf(this.db, sale.tenantId), "r", sale.receiptToken);
    const documents = availableDocuments(sale);
    const label = documents.includes("receipt") ? `receipt ${sale.saleNumber}` : sale.balanceMinor > 0n || !sale.collectedAt ? `invoice ${sale.invoiceNumber ?? ""}` : `receipt ${sale.saleNumber ?? ""}`;
    // Written as the business speaking to its customer (6e).
    const greeting = customer?.name && !customer.isWalkIn ? `Hello ${customer.name}, ` : "Hello, ";
    const message = `${greeting}here is your ${label.trim()} from ${extra?.businessName ?? "us"}: `;
    return {
      ...this.summaryOf(sale),
      ...stages,
      view: "full" as const,
      customerName: customer?.name ?? null,
      customerPhoneLast4: customer?.phoneE164 ? customer.phoneE164.slice(-4) : null,
      // What the cashier needs to give credit: whether the customer is approved, the limit and what they owe now.
      customerCredit: customer
        ? { allowed: customer.creditAllowed, limitMinor: customer.creditLimitMinor?.toString() ?? null, owingMinor: (await this.owing(this.db, tenant.tenantId, customer.id)).toString() }
        : null,
      businessName: extra?.businessName ?? null,
      note: sale.note,
      voidReason: sale.voidReason,
      receiptPath,
      documents,
      // The web app adds its own origin to the link. A customer's number is used only for people who may see it.
      whatsApp: {
        text: message,
        phone: seeContact && customer?.phoneE164 ? customer.phoneE164 : null,
        hrefPrefix: seeContact && customer?.phoneE164 ? whatsAppHref(customer.phoneE164, "") : "https://wa.me/",
      },
      returnedMinor: sale.returnedMinor.toString(),
      returns: returned.returns,
      // Who may record returns, and whether this sale can still take one.
      canReturn: tenant.permissions.includes(Permission.SALES_VOID) && sale.status === "completed" && !sale.historyOnly,
      lines: lines.map((line) => ({
        id: line.id,
        returnedQuantity: (returnedByLine.get(line.id) ?? 0n).toString(),
        productId: line.productId,
        lineKind: line.lineKind,
        description: line.description,
        quantity: line.quantity.toString(),
        enteredQuantity: line.enteredQuantity.toString(),
        enteredUnit: line.enteredUnit,
        unitPriceMinor: line.unitPriceMinor.toString(),
        discountMinor: line.discountMinor.toString(),
        lineTotalMinor: line.lineTotalMinor.toString(),
        ...(seeCost && line.costMinor !== null ? { costMinor: line.costMinor.toString() } : {}),
        ...(line.possibleProductId && possibleById.get(line.possibleProductId) ? { possibleProduct: possibleById.get(line.possibleProductId) } : {}),
        serials: serialsByLine.get(line.id) ?? [],
        keepsSerials: Boolean(line.productId && keepsSerials.has(line.productId)),
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        method: payment.method,
        amountMinor: payment.amountMinor.toString(),
        reference: payment.reference,
        // Transfers waiting for confirmation, or that never came (ADR-031).
        confirmation: payment.confirmation,
        notReceivedAs: payment.notReceivedAs,
      })),
      // Debtor payments made after the sale (ADR-019).
      laterPayments: laterPayments.map((payment) => ({ id: payment.id, number: payment.number, method: payment.method, amountMinor: payment.amount.toString(), receivedAt: payment.receivedAt, confirmation: payment.confirmation })),
    };
  }

  private laterPayments(sale: SaleRow) {
    return this.db
      .select({ id: customerPayments.id, number: customerPayments.paymentNumber, method: customerPayments.method, amount: paymentAllocations.amountMinor, receivedAt: customerPayments.receivedAt, confirmation: customerPayments.confirmation })
      .from(paymentAllocations)
      .innerJoin(customerPayments, and(eq(customerPayments.tenantId, paymentAllocations.tenantId), eq(customerPayments.id, paymentAllocations.paymentId)))
      .where(and(eq(paymentAllocations.tenantId, sale.tenantId), eq(paymentAllocations.saleId, sale.id), eq(customerPayments.status, "recorded")))
      .orderBy(asc(customerPayments.receivedAt));
  }

  /** What anyone with the receipt link may see: the receipt, nothing else about the shop or customer. */
  async publicReceipt(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [row] = await this.db
      .select({
        sale: sales,
        businessName: businesses.name,
        businessPhone: businesses.phoneE164,
        branchName: branches.name,
        branchPhone: branches.phoneE164,
        address: addresses,
        customerName: customers.name,
        customerAddress: customerAddresses,
      })
      .from(sales)
      .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
      .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
      .leftJoin(addresses, and(eq(addresses.tenantId, branches.tenantId), eq(addresses.id, branches.addressId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(customerAddresses, and(eq(customerAddresses.tenantId, customers.tenantId), eq(customerAddresses.id, customers.addressId)))
      .where(eq(sales.receiptToken, token))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [lines, payments] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, row.sale.tenantId), eq(saleLines.saleId, row.sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, row.sale.tenantId), eq(salePayments.saleId, row.sale.id))),
    ]);
    // The shop's contact and the owner's message, so the customer knows who to call and how to pay (6d).
    const paidOrCredit = row.sale.collectedAt !== null;
    const brand = await this.branding.publicBrand(row.sale.tenantId, paidOrCredit && row.sale.balanceMinor === 0n ? "receipt" : "invoice");
    return {
      businessName: row.businessName,
      branchName: row.branchName,
      shop: {
        phone: row.branchPhone ?? row.businessPhone ?? null,
        address: row.address
          ? formatAddressDisplay({
              shopNumber: row.address.shopNumber,
              lineOrBlock: row.address.lineOrBlock,
              marketOrPlaza: row.address.marketOrPlaza,
              line1: row.address.line1,
              city: row.address.city,
              subdivisionName: null,
            })
          : null,
      },
      message: brand.message,
      hasLogo: brand.hasLogo,
      // The page lives at /<handle>/r/<token>; an old or wrong name in the address is redirected to this one.
      handle: brand.handle,
      color: brand.color,
      customerName: row.customerName,
      // The same address the invoice and receipt PDFs behind this link print (7f).
      customerAddress: row.customerName ? addressText(row.customerAddress) : null,
      number: row.sale.saleNumber,
      invoiceNumber: row.sale.invoiceNumber,
      provisionalNumber: row.sale.provisionalNumber,
      status: row.sale.status,
      dueDate: row.sale.balanceMinor > 0n ? row.sale.dueDate : null,
      documents: availableDocuments(row.sale),
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

  /** A sale's invoice or receipt as a PDF, for staff who may see the sale in full (not the store keeper's view). */
  async document(tenant: TenantContext, id: string, type: SaleDocumentType) {
    const sale = await this.requireSale(this.db, tenant, id);
    if (this.viewOf(tenant, sale) !== "full") throw new ApiError("FORBIDDEN", "You cannot see the amounts on this sale.", 403);
    return this.renderDocument(sale, type);
  }

  /** The same PDF for anyone with the receipt link the customer was sent. */
  async publicDocument(token: string, type: SaleDocumentType) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [sale] = await this.db.select().from(sales).where(eq(sales.receiptToken, token)).limit(1);
    if (!sale) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    return this.renderDocument(sale, type);
  }

  /** The company logo for a customer's receipt page, found from the receipt's own token. */
  async publicLogo(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    const [sale] = await this.db.select({ tenantId: sales.tenantId }).from(sales).where(eq(sales.receiptToken, token)).limit(1);
    if (!sale) throw new ApiError("NOT_FOUND", "Receipt not found.", 404);
    return this.branding.logoForTenant(sale.tenantId);
  }

  private async renderDocument(sale: SaleRow, type: SaleDocumentType) {
    const input = await this.documentInput(sale);
    if (!availableDocuments(input.sale).includes(type)) {
      throw new ApiError("NO_DOCUMENT", type === "receipt" ? "There is no receipt yet: the cashier has not taken payment." : "This sale has no invoice.", 404);
    }
    const model = documentModel(input, type);
    return { fileName: model.fileName, pdf: await renderPdf(model, await this.branding.documentBrand(this.db, sale.tenantId, type)) };
  }

  private async documentInput(sale: SaleRow): Promise<DocumentInput> {
    const name = (userId: string | null) => (userId ? sql<string | null>`(SELECT display_name FROM users WHERE users.id = ${userId})` : sql<null>`NULL`);
    const [extra] = await this.db
      .select({
        business: businesses,
        branch: branches,
        address: addresses,
        customerName: customers.name,
        customerAddress: customerAddresses,
        servedBy: name(sale.createdBy),
        cashier: name(sale.collectedBy),
      })
      .from(sales)
      .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
      .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
      .leftJoin(addresses, and(eq(addresses.tenantId, branches.tenantId), eq(addresses.id, branches.addressId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(customerAddresses, and(eq(customerAddresses.tenantId, customers.tenantId), eq(customerAddresses.id, customers.addressId)))
      .where(and(eq(sales.tenantId, sale.tenantId), eq(sales.id, sale.id)))
      .limit(1);
    if (!extra) throw new ApiError("NOT_FOUND", "Sale not found.", 404);
    const [lines, payments] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, sale.tenantId), eq(saleLines.saleId, sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, sale.tenantId), eq(salePayments.saleId, sale.id))).orderBy(asc(salePayments.createdAt)),
    ]);
    const serialsOnDocument = await this.serials.ofLines(this.db, sale.tenantId, lines.map((line) => line.id));
    const address = extra.address
      ? formatAddressDisplay({
          shopNumber: extra.address.shopNumber,
          lineOrBlock: extra.address.lineOrBlock,
          marketOrPlaza: extra.address.marketOrPlaza,
          line1: extra.address.line1,
          city: extra.address.city,
          subdivisionName: null,
        })
      : null;
    return {
      sale: {
        status: sale.status as SaleStatus,
        historyOnly: sale.historyOnly,
        saleNumber: sale.saleNumber,
        invoiceNumber: sale.invoiceNumber,
        provisionalNumber: sale.provisionalNumber,
        collectedAt: sale.collectedAt,
        soldAt: sale.soldAt,
        dueDate: sale.dueDate,
        currency: sale.currencyCode.trim(),
        subtotalMinor: sale.subtotalMinor,
        discountMinor: sale.discountMinor,
        totalMinor: sale.totalMinor,
        paidMinor: sale.paidMinor,
        balanceMinor: sale.balanceMinor,
        voidReason: sale.voidReason,
      },
      business: { name: extra.business.name, phone: extra.business.phoneE164, timezone: extra.business.timezone, returnsWithinDays: extra.business.returnsWithinDays, returnsOnReceipt: extra.business.returnsOnReceipt },
      branch: { name: extra.branch.name, address: address || null, phone: extra.branch.phoneE164 },
      customerName: extra.customerName,
      customerAddress: addressText(extra.customerAddress),
      servedBy: extra.servedBy,
      cashier: extra.cashier,
      lines: lines.map((line) => ({
        description: line.description,
        serials: serialsOnDocument.get(line.id) ?? [],
        enteredQuantity: line.enteredQuantity,
        enteredUnit: line.enteredUnit,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
      })),
      payments: [
        ...payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor })),
        ...(await this.laterPayments(sale)).map((payment) => ({ method: payment.method, amountMinor: payment.amount, label: `Paid later (${payment.number})` })),
      ],
    };
  }

  // Helpers -----------------------------------------------------------------------------------------------------------

  /**
   * Takes the money: checks payments and credit, and posts cash / bank / POS clearing / debtors against sales.
   * Credit needs a customer approved for credit by a manager or owner, a date it should be paid and a comment.
   * Staff with sales.credit stay within the customer's limit; managers and owners (debtors.manage) may go over it,
   * which is written in the activity log. Imported past sales skip the approval checks (ADR-015).
   */
  private async settle(
    tx: DbExecutor,
    tenant: TenantContext,
    business: BusinessRow,
    branch: BranchRow,
    input: {
      id: string;
      number: string;
      subtotal: bigint;
      /** Lines not in the products (services); they earn service income (ADR-035). */
      otherSubtotal?: bigint;
      discount: bigint;
      total: bigint;
      entryDate: string;
      payments: Payment[];
      customer: CustomerRow | null;
      dueDate: string | undefined;
      comment: string | undefined;
      source: SaleSource;
    },
  ) {
    const paidByMethod = new Map<string, bigint>();
    for (const payment of input.payments) {
      paidByMethod.set(payment.method, (paidByMethod.get(payment.method) ?? 0n) + BigInt(payment.amountMinor));
    }
    const paid = [...paidByMethod.values()].reduce((sum, amount) => sum + amount, 0n);
    if (paid > input.total) {
      throw new ApiError("OVERPAID", "Payments add up to more than the total. Record only what the sale costs; give change from the drawer.", 400, [
        { field: "payments", message: "Too much." },
      ]);
    }
    const balance = input.total - paid;
    let overLimit = false;
    let creditOffline: { customerName: string; reason: "not_approved" | "over_limit" | "both" } | null = null;
    const offline = input.source === "offline";
    if (balance > 0n) {
      const customer = input.customer;
      if (!customer) {
        throw new ApiError("CUSTOMER_REQUIRED", "Choose the customer who will owe the balance.", 400, [{ field: "customerId", message: "Required for credit." }]);
      }
      const manager = tenant.permissions.includes(Permission.DEBTORS_MANAGE);
      if (!offline && !manager && !tenant.permissions.includes(Permission.SALES_CREDIT)) {
        throw new ApiError("FORBIDDEN", "You cannot sell on credit. Take full payment, or send the sale to the cashier.", 403, [{ field: "payments", message: "Full payment needed." }]);
      }
      // Imported or captured records were already agreed with the customer; they skip approval checks (ADR-015, ADR-018).
      // An offline sale already happened: keep a past date, a missing comment, and credit that is no longer allowed (ADR-050).
      if (input.source !== "import" && input.source !== "capture") {
        const notApproved = !customer.creditAllowed;
        let over = false;
        if (customer.creditLimitMinor !== null) {
          const owing = await this.owing(tx, tenant.tenantId, customer.id);
          if (owing + balance > customer.creditLimitMinor) over = true;
        }
        if (offline) {
          if (notApproved || over) {
            creditOffline = { customerName: customer.name, reason: notApproved && over ? "both" : notApproved ? "not_approved" : "over_limit" };
          }
          if (over) overLimit = true;
        } else {
          if (notApproved) {
            throw new ApiError("CREDIT_NOT_APPROVED", `${customer.name} is not approved for credit. A manager or owner can approve them on the customer's page.`, 403, [
              { field: "customerId", message: "Not approved for credit." },
            ]);
          }
          if (over) {
            if (!manager) {
              throw new ApiError("OVER_CREDIT_LIMIT", `This would take ${customer.name} over their credit limit. Take more payment or ask a manager.`, 403, [
                { field: "payments", message: "Over the credit limit." },
              ]);
            }
            overLimit = true;
          }
          if (!input.dueDate) throw new ApiError("DUE_DATE_REQUIRED", "Enter the date the customer will pay.", 400, [{ field: "dueDate", message: "Required for credit." }]);
          if (input.dueDate < localDate(new Date(), business.timezone)) {
            throw new ApiError("VALIDATION_ERROR", "The payment date cannot be in the past.", 400, [{ field: "dueDate", message: "In the past." }]);
          }
          if (!input.comment) throw new ApiError("COMMENT_REQUIRED", "Write a comment for this credit: why, and how the customer will pay.", 400, [{ field: "comment", message: "Required for credit." }]);
        }
      }
    }

    const income = businessTypeFromIndustry(business.industryCode) === "services" ? "service_income" : "sales";
    const posting: PostingLine[] = [];
    // Staff who cannot see the bank put transfers in "waiting for confirmation" until someone checks (ADR-031).
    const transfersWait = transferWaits(tenant, input.source) && (paidByMethod.get("transfer") ?? 0n) > 0n;
    const methodAccount = {
      cash: { role: "cash" as const, branchId: branch.id },
      transfer: { role: transfersWait ? ("transfers_waiting" as const) : ("bank" as const) },
      pos: { role: "pos_clearing" as const },
    };
    for (const [method, amount] of paidByMethod) {
      if (amount > 0n) posting.push({ account: methodAccount[method as keyof typeof methodAccount], debitMinor: amount, memo: method });
    }
    if (balance > 0n) posting.push({ account: { role: "debtors" }, debitMinor: balance, memo: "Owed by customer" });
    if (input.discount > 0n) posting.push({ account: { role: "discounts" }, debitMinor: input.discount });
    const other = income === "service_income" ? 0n : (input.otherSubtotal ?? 0n);
    if (input.subtotal - other > 0n) posting.push({ account: { role: income }, creditMinor: input.subtotal - other });
    if (other > 0n) posting.push({ account: { role: "service_income" }, creditMinor: other, memo: "Services and other items" });
    let journalEntryId: string | null = null;
    if (posting.length >= 2) {
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: input.entryDate,
          source: { type: "sale", id: input.id },
          postingKey: `sale:${input.id}`,
          description: `Sale ${input.number}`,
          lines: posting,
        },
      );
      journalEntryId = posted.entryId;
    }
    return { paid, balance, journalEntryId, overLimit, transfersWait, creditOffline };
  }

  /** Takes the sale's goods out of stock (counted products only) and remembers each line's cost. */
  /** Refuses a sale that asks for more of a counted product than is on the shelf in this shop (review, 19 Nov). */
  private async assertOnShelf(tx: DbExecutor, tenant: TenantContext, branch: BranchRow, items: { product: ProductRow | null | undefined; quantity: bigint }[]) {
    const wanted = new Map<string, { product: ProductRow; quantity: bigint }>();
    for (const item of items) {
      if (!item.product?.trackStock) continue;
      const current = wanted.get(item.product.id);
      wanted.set(item.product.id, { product: item.product, quantity: (current?.quantity ?? 0n) + item.quantity });
    }
    if (wanted.size === 0) return;
    const balances = await tx
      .select({ productId: stockBalances.productId, quantity: stockBalances.quantity })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, branch.id), inArray(stockBalances.productId, [...wanted.keys()])));
    const onHand = new Map(balances.map((row) => [row.productId, row.quantity]));
    for (const { product, quantity } of wanted.values()) {
      const have = onHand.get(product.id) ?? 0n;
      if (quantity > have) {
        const left = have > 0n ? have : 0n;
        throw new ApiError("NOT_ENOUGH_STOCK", `Not enough ${product.name} in ${branch.name}: ${quantityToString(left)} ${product.baseUnit} left, ${quantityToString(quantity)} ${product.baseUnit} on this sale.`, 422, [
          { field: "lines", message: `Only ${quantityToString(left)} left.` },
        ]);
      }
    }
  }

  /**
   * Takes the sale's goods out of stock. A sale made here and now cannot take more than is on the shelf; a sale that
   * already happened elsewhere (no network, typed in from a book or a photo) is recorded as it was and flagged.
   */
  private async takeStock(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, branch: BranchRow, saleId: string, number: string, occurredAt: Date, source: string) {
    const lines = await tx.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, saleId))).orderBy(asc(saleLines.lineNo));
    const ids = [...new Set(lines.map((line) => line.productId).filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return;
    const rows = await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const line of lines) {
      const product = line.productId ? byId.get(line.productId) : undefined;
      if (!product?.trackStock || line.stockMovementId) continue;
      const movement = await this.stock.applyMovement(tx, { tenant, business, branch, product }, {
        type: "sold",
        quantity: -line.quantity,
        enteredQuantity: line.enteredQuantity,
        enteredUnit: line.enteredUnit,
        note: number,
        occurredAt,
        mayGoBelowZero: source !== "pos",
      });
      await tx
        .update(saleLines)
        .set({ stockMovementId: movement.id, costMinor: knownLineCost(-movement.valueMinor, product) })
        .where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.id, line.id)));
    }
  }

  private async insertPayments(tx: DbExecutor, tenant: TenantContext, businessId: string, saleId: string, payments: Payment[], transfersWait = false) {
    const rows = payments.filter((payment) => BigInt(payment.amountMinor) > 0n);
    if (rows.length === 0) return;
    await tx.insert(salePayments).values(
      rows.map((payment) => ({
        id: newId(),
        tenantId: tenant.tenantId,
        businessId,
        saleId,
        method: payment.method,
        amountMinor: BigInt(payment.amountMinor),
        reference: payment.reference ?? null,
        confirmation: transfersWait && payment.method === "transfer" ? "waiting" : "confirmed",
      })),
    );
  }

  /** Tells the people who can see the bank that a transfer needs checking (ADR-031). */
  private async askToCheckTransfer(tx: DbExecutor, tenant: TenantContext, businessId: string, saleId: string) {
    await this.notifications.notify(tx, tenant.tenantId, await bankCheckers(tx, tenant.tenantId, businessId), {
      kind: "transfer.waiting",
      saleId,
      actorName: await this.actorName(tx, tenant),
      except: tenant.membershipId,
    });
  }

  private async addComment(tx: DbExecutor, tenant: TenantContext, businessId: string, saleId: string, body: string, kind: "comment" | "credit") {
    await tx.insert(saleComments).values({ id: newId(), tenantId: tenant.tenantId, businessId, saleId, userId: tenant.userId, membershipId: tenant.membershipId, role: tenant.role, kind, body });
  }

  /** What a customer owes from credit sales. Debtor payments (Sprint 6) will reduce it. */
  private async owing(executor: DbExecutor, tenantId: string, customerId: string) {
    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${sales.balanceMinor}), 0)` })
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.customerId, customerId), eq(sales.historyOnly, false), inArray(sales.status, ["awaiting_release", "completed"])));
    return BigInt(row?.total ?? 0);
  }

  /** Store keepers who work in this shop (or in every shop of the business). */
  private async storeKeepers(tx: DbExecutor, tenantId: string, businessId: string, branchId: string) {
    if (RELEASE_ROLES.length === 0) return [];
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, "ACTIVE"),
          inArray(memberships.role, RELEASE_ROLES),
          or(isNull(memberships.businessId), eq(memberships.businessId, businessId)),
          or(isNull(memberships.branchId), eq(memberships.branchId, branchId)),
        ),
      );
    return rows.map((row) => row.id);
  }

  private async actorName(tx: DbExecutor, tenant: TenantContext) {
    const [row] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, tenant.userId)).limit(1);
    return row?.name ?? null;
  }

  private async record(tx: DbExecutor, tenant: TenantContext, sale: SaleRow, action: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "sale",
        entityId: sale.id,
        correlationId: tenant.correlationId,
        businessId: sale.businessId,
        branchId: sale.branchId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { number: sale.saleNumber, invoiceNumber: sale.invoiceNumber, ...metadata },
      },
      tx,
    );
  }

  /**
   * A typed name that is one product in this business (the product's name, another name, or a remembered item
   * already linked to it). Spaces and punctuation are ignored. Two products for the same name are left alone,
   * so stock is not taken from the wrong one. The product list is filtered by the compact name, not read in full (ADR-052).
   */
  private async productsForTypedNames(tx: DbExecutor, tenantId: string, businessId: string, keys: string[]) {
    const found = new Map<string, string>();
    if (keys.length === 0) return found;
    const wanted = new Set(keys);
    const keysForCompact = new Map<string, string[]>();
    for (const key of keys) {
      const compact = compactItemKey(key);
      if (!compact) continue;
      keysForCompact.set(compact, [...(keysForCompact.get(compact) ?? []), key]);
    }
    const compacts = [...keysForCompact.keys()];
    const idsFor = new Map<string, Set<string>>();
    const add = (key: string, id: string | null, live: Set<string>) => {
      if (!id || !wanted.has(key) || !live.has(id)) return;
      const set = idsFor.get(key) ?? new Set<string>();
      set.add(id);
      idsFor.set(key, set);
    };
    const named =
      compacts.length === 0
        ? []
        : await tx
            .select({ id: products.id, compactKey: products.compactKey })
            .from(products)
            .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), inArray(products.compactKey, compacts)));
    const liveIds = new Set(named.map((product) => product.id));
    for (const product of named) {
      for (const key of keysForCompact.get(product.compactKey) ?? []) add(key, product.id, liveIds);
    }
    const aliases =
      compacts.length === 0
        ? []
        : await tx
            .select({ compactKey: itemAliases.compactKey, productId: itemAliases.productId })
            .from(itemAliases)
            .innerJoin(products, and(eq(products.tenantId, itemAliases.tenantId), eq(products.businessId, itemAliases.businessId), eq(products.id, itemAliases.productId), isNull(products.archivedAt)))
            .where(and(eq(itemAliases.tenantId, tenantId), eq(itemAliases.businessId, businessId), inArray(itemAliases.compactKey, compacts), isNotNull(itemAliases.productId)));
    const aliasLive = new Set(aliases.map((alias) => alias.productId).filter((id): id is string => Boolean(id)));
    for (const alias of aliases) {
      for (const key of keysForCompact.get(alias.compactKey) ?? []) add(key, alias.productId, aliasLive);
    }
    const linked = await tx
      .select({ nameKey: savedItems.nameKey, productId: savedItems.productId })
      .from(savedItems)
      .innerJoin(products, and(eq(products.tenantId, savedItems.tenantId), eq(products.businessId, savedItems.businessId), eq(products.id, savedItems.productId), isNull(products.archivedAt)))
      .where(and(eq(savedItems.tenantId, tenantId), eq(savedItems.businessId, businessId), inArray(savedItems.nameKey, keys), isNotNull(savedItems.productId)));
    const linkedLive = new Set(linked.map((item) => item.productId).filter((id): id is string => Boolean(id)));
    for (const item of linked) add(item.nameKey, item.productId, linkedLive);
    for (const [key, ids] of idsFor) {
      if (ids.size === 1) found.set(key, [...ids][0] as string);
    }
    return found;
  }

  /**
   * A typed name that is not a product, but is close to exactly one. Shorter names, and two close products, are left alone.
   * Only products that start with the same four characters are read (ADR-052).
   */
  private async closeSpellings(tx: DbExecutor, tenantId: string, businessId: string, keys: string[], matched: Map<string, string>) {
    const asked = keys
      .filter((key) => !matched.has(key))
      .map((key) => ({ key, compact: compactItemKey(key) }))
      .filter((item) => item.compact.length >= 6);
    const found = new Map<string, { id: string; name: string; priceMinor: bigint | null }>();
    if (asked.length === 0) return found;
    const prefixes = [...new Set(asked.map((item) => item.compact.slice(0, 4)))];
    const prefix =
      prefixes.length === 1 ? like(products.compactKey, `${prefixes[0]}%`) : or(...prefixes.map((item) => like(products.compactKey, `${item}%`)));
    const rows = await tx
      .select({ id: products.id, name: products.name, priceMinor: products.priceMinor, compactKey: products.compactKey })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`char_length(${products.compactKey}) >= 6`, prefix));
    for (const item of asked) {
      const hits = rows.filter((row) => closeProductKey(item.compact, row.compactKey));
      const ids = [...new Set(hits.map((hit) => hit.id))];
      if (ids.length !== 1) continue;
      const hit = hits[0];
      if (hit) found.set(item.key, { id: hit.id, name: hit.name, priceMinor: hit.priceMinor });
    }
    return found;
  }

  /**
   * Prices a listed product. A name the seller typed uses the same unit, price list and below-price checks.
   * A sale made now refuses a price below the list, or a free one, unless the person may give discounts.
   * A typed name on a sale that already happened keeps the seller's price and is flagged. A product chosen by
   * id keeps the old check on every source. Returns null when a typed unit is not one this product is sold in
   * and the sale already happened, so the line stays typed and stock is not guessed.
   */
  private priceListedLine(
    product: ProductRow,
    productUnits: ProductUnitRow[],
    input: { unit: string; quantity: string; unitPriceMinor?: string | undefined; lineTotalMinor?: string | undefined },
    index: number,
    tiers: Map<string, { minQuantity: bigint; priceMinor: bigint }[]> | null,
    canDiscount: boolean,
    live: boolean,
    fromTyped: boolean,
    keepPrice: boolean,
  ) {
    const selling = [product.baseUnit, ...productUnits.filter((unit) => !live || unit.forSale).map((unit) => unit.unitCode)];
    if (fromTyped && !selling.includes(input.unit)) {
      if (!live) return null;
      const message = soldBy(product.name, selling);
      throw new ApiError("VALIDATION_ERROR", message, 400, [{ field: `lines.${index}.unit`, message }]);
    }
    const factor = unitFactor(product, productUnits, input.unit, live ? "sale" : undefined);
    const entered = parseQuantity(input.quantity) as bigint;
    const quantity = round(entered * factor, 1000n);
    if (quantity <= 0n) throw new ApiError("VALIDATION_ERROR", "Enter a larger quantity.", 400, [{ field: `lines.${index}.quantity`, message: "Too small." }]);
    const pack = productUnits.find((unit) => unit.unitCode === input.unit);
    const shelfPrice =
      input.unit === product.baseUnit ? product.priceMinor : (pack?.priceMinor ?? (product.priceMinor !== null ? round(product.priceMinor * factor, 1000n) : null));
    const listPrice = tierPrice(tiers?.get(`${product.id}:${input.unit}`), entered) ?? shelfPrice;
    const unitPrice = input.unitPriceMinor !== undefined ? BigInt(input.unitPriceMinor) : listPrice;
    if (unitPrice === null) {
      throw new ApiError("PRICE_REQUIRED", `Enter a price for ${product.name}.`, 400, [{ field: `lines.${index}.unitPriceMinor`, message: "Price needed." }]);
    }
    const exact = input.lineTotalMinor !== undefined ? BigInt(input.lineTotalMinor) : null;
    if (exact !== null && exact <= 0n) {
      throw new ApiError("VALIDATION_ERROR", "Enter a price.", 400, [{ field: `lines.${index}.lineTotalMinor`, message: "Enter a price." }]);
    }
    const listLine = listPrice !== null ? round(listPrice * entered, 1000n) : null;
    const shelfLine = shelfPrice !== null ? round(shelfPrice * entered, 1000n) : null;
    const lineTotal = exact ?? round(unitPrice * entered, 1000n);
    const cheaper = (price: bigint | null, whole: bigint | null) => (exact !== null ? whole !== null && exact < whole : price !== null && unitPrice < price);
    // A live sale is checked against the price in force (the list, or today's price). An offline sale is also
    // flagged when the phone's price is under today's price even if a list price matches it (ADR-050).
    const below = cheaper(listPrice, listLine) || (keepPrice && shelfPrice !== listPrice && cheaper(shelfPrice, shelfLine));
    const free = exact !== null ? false : unitPrice === 0n;
    // A product picked by id is checked on a live sale. A typed name is checked only at the counter (ADR-049).
    // An offline sale keeps the price the phone showed, even when today's price is different, and the owner is told (ADR-050).
    const kept = keepPrice || (fromTyped && !live);
    const strictPrice = !kept;
    if (strictPrice && free && !canDiscount) {
      throw new ApiError("FORBIDDEN", `Ask a manager to give ${product.name} away free.`, 403, [{ field: `lines.${index}.unitPriceMinor`, message: "Enter the price." }]);
    }
    if (strictPrice && below && !canDiscount) {
      throw new ApiError("FORBIDDEN", `Ask a manager to sell ${product.name} below its price.`, 403, [{ field: `lines.${index}.unitPriceMinor`, message: "Below the price." }]);
    }
    const reduction = below && listLine !== null ? (exact !== null ? listLine - exact : round(((listPrice as bigint) - unitPrice) * entered, 1000n)) : 0n;
    return {
      below: kept && !canDiscount && (free || below),
      line: { product, unit: input.unit, entered, quantity, unitPrice, lineTotal, reduction, description: product.name, other: false as const, saved: false as const },
    };
  }

  /** The owner is told when an offline, imported or captured sale sold a product below its price. The price is kept. */
  private async flagBelowPrice(tx: DbExecutor, tenant: TenantContext, businessId: string, branchId: string, saleId: string, names: string[]) {
    const unique = [...new Set(names)];
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "sale.below_price",
        entityType: "sale",
        entityId: saleId,
        correlationId: tenant.correlationId,
        businessId,
        branchId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { names: unique },
      },
      tx,
    );
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
      kind: "sale.below_price",
      saleId,
      actorName: await this.actorName(tx, tenant),
      data: { summary: unique.join(", ") },
    });
  }

  /** A live sale names the one product a typed line looked like. The line itself stays typed. */
  private async possibleProducts(tenantId: string, source: string, lines: { possibleProductId: string | null }[]) {
    const ids = source === "pos" ? [...new Set(lines.flatMap((line) => (line.possibleProductId ? [line.possibleProductId] : [])))] : [];
    if (ids.length === 0) return new Map<string, { id: string; name: string; priceMinor: string | null }>();
    const rows = await this.db
      .select({ id: products.id, name: products.name, priceMinor: products.priceMinor })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids)));
    return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, priceMinor: row.priceMinor?.toString() ?? null }]));
  }

  /** The owner is told when a typed name was close to one product. The sale stays as it was typed. */
  private async flagTypedLikeProduct(
    tx: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    branchId: string,
    saleId: string,
    matches: { typed: string; name: string }[],
  ) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "sale.typed_like_product",
        entityType: "sale",
        entityId: saleId,
        correlationId: tenant.correlationId,
        businessId,
        branchId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { matches },
      },
      tx,
    );
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
      kind: "sale.typed_like_product",
      saleId,
      actorName: await this.actorName(tx, tenant),
      data: { summary: matches.map((match) => `${match.typed}, which looks like ${match.name}`).join("; ") },
    });
  }

  /** The owner is told when an offline sale was given on credit that would not be allowed at the counter. */
  private async flagCreditOffline(
    tx: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    branchId: string,
    saleId: string,
    detail: { customerName: string; reason: "not_approved" | "over_limit" | "both" },
  ) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "sale.credit_offline",
        entityType: "sale",
        entityId: saleId,
        correlationId: tenant.correlationId,
        businessId,
        branchId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { reason: detail.reason },
      },
      tx,
    );
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
      kind: "sale.credit_offline",
      saleId,
      actorName: await this.actorName(tx, tenant),
      data: { summary: detail.customerName, reason: detail.reason },
    });
  }

  /** The owner is told when an offline sale was recorded in a shop that has since closed. */
  private async flagClosedShop(tx: DbExecutor, tenant: TenantContext, businessId: string, branchId: string, saleId: string, shopName: string) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: "sale.closed_shop",
        entityType: "sale",
        entityId: saleId,
        correlationId: tenant.correlationId,
        businessId,
        branchId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { shop: shopName },
      },
      tx,
    );
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
    await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
      kind: "sale.closed_shop",
      saleId,
      actorName: await this.actorName(tx, tenant),
      data: { summary: shopName },
    });
  }

  /**
   * Prices each line from the product (or the price typed), checks discounts, and converts to base units.
   * `live`: a sale made now at the counter. A typed name that is a product is price-checked only then.
   * Offline sales keep the price the phone showed, for a product picked by id as well as a typed name, and tell
   * the owner when that price is below today's. Imported and photo-read sales keep a typed price and tell the owner.
   * Pack rules (ADR-046) are not applied except on a live sale. A product chosen by id is still price-checked on a live sale.
   */
  private async priceLines(
    tx: DbExecutor,
    tenant: TenantContext,
    business: BusinessRow,
    payload: SaleCreateInput,
    priceList: { id: string; day: string } | null = null,
    live = false,
    keepPrice = false,
  ) {
    const typedKeys = [...new Set(payload.lines.flatMap((line) => ("productId" in line || isAmountLine(line) ? [] : [savedItemKey(line.description)])).filter((key) => key.length > 0))];
    const matched = await this.productsForTypedNames(tx, tenant.tenantId, business.id, typedKeys);
    const near = await this.closeSpellings(tx, tenant.tenantId, business.id, typedKeys, matched);
    const ids = [...new Set([...payload.lines.flatMap((line) => ("productId" in line ? [line.productId] : [])), ...matched.values()])];
    const rows =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(products)
            .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), inArray(products.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const units = await productUnitsFor(tx, tenant.tenantId, ids);
    const fromList = priceList ? await listPrices(tx, tenant.tenantId, priceList.id, ids, priceList.day) : null;
    const canDiscount = tenant.permissions.includes(Permission.SALES_DISCOUNT);
    const lines = [];
    const belowPrice: string[] = [];
    const likeProduct: { typed: string; name: string }[] = [];
    for (const [index, line] of payload.lines.entries()) {
      // Just an amount (ADR-069): no item, so nothing to price, remember or take from stock. The shop must allow it.
      if (isAmountLine(line)) {
        if (!business.amountSales) {
          throw new ApiError("AMOUNT_SALES_OFF", "This shop records what was sold, not just amounts. The owner can allow amounts in Settings.", 403, [
            { field: `lines.${index}.amountMinor`, message: "Choose what was sold." },
          ]);
        }
        const amount = BigInt(line.amountMinor);
        lines.push({
          product: null,
          unit: "piece",
          entered: 1000n,
          quantity: 1000n,
          unitPrice: amount,
          lineTotal: amount,
          reduction: 0n,
          description: line.description?.replace(/\s+/g, " ").trim() || AMOUNT_LINE_NAME,
          other: true as const,
          saved: false,
          amount: true,
          possibleProductId: null,
        });
        continue;
      }
      if (!("productId" in line)) {
        const productId = matched.get(savedItemKey(line.description));
        const product = productId ? byId.get(productId) : undefined;
        if (product && !product.archivedAt) {
          const priced = this.priceListedLine(
            product,
            units.get(product.id) ?? [],
            { unit: line.unit ?? "piece", quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, lineTotalMinor: line.lineTotalMinor },
            index,
            fromList,
            canDiscount,
            live,
            true,
            keepPrice,
          );
          if (priced) {
            lines.push(priced.line);
            if (priced.below) belowPrice.push(product.name);
            continue;
          }
        }
        const entered = parseQuantity(line.quantity) as bigint;
        const unitPrice = BigInt(line.unitPriceMinor);
        const exact = line.lineTotalMinor !== undefined ? BigInt(line.lineTotalMinor) : null;
        if (exact !== null && exact <= 0n) {
          throw new ApiError("VALIDATION_ERROR", "Enter a price.", 400, [{ field: `lines.${index}.lineTotalMinor`, message: "Enter a price." }]);
        }
        if (exact === null && unitPrice === 0n && !canDiscount) {
          throw new ApiError("FORBIDDEN", `Ask a manager to give "${line.description}" free.`, 403, [{ field: `lines.${index}.unitPriceMinor`, message: "Enter the price." }]);
        }
        const description = line.description.replace(/\s+/g, " ");
        // A whole sale typed into the item box is not an item name (ADR-057). Offline sales are kept as they came.
        if (live && line.saved === true && description.length > TYPED_ITEM_NAME_MAX) {
          throw new ApiError(
            "ITEM_NAME_TOO_LONG",
            `That looks like a whole sale, not an item's name. Use "Read this as a sale", or keep the name under ${TYPED_ITEM_NAME_MAX} letters.`,
            400,
            [{ field: `lines.${index}.description`, message: "Too long for an item name." }],
          );
        }
        const hint = near.get(savedItemKey(line.description));
        if (hint) likeProduct.push({ typed: description.slice(0, 160), name: hint.name });
        lines.push({
          product: null,
          unit: line.unit ?? "piece",
          entered,
          quantity: entered,
          unitPrice,
          lineTotal: exact ?? round(unitPrice * entered, 1000n),
          reduction: 0n,
          description,
          other: true as const,
          saved: line.saved === true,
          amount: false,
          possibleProductId: live && hint ? hint.id : null,
        });
        continue;
      }
      const product = byId.get(line.productId);
      if (!product || product.archivedAt) {
        throw new ApiError("PRODUCT_NOT_FOUND", "A product in this sale was not found.", 404, [{ field: `lines.${index}.productId`, message: "Not found." }]);
      }
      const priced = this.priceListedLine(product, units.get(product.id) ?? [], { unit: line.unit, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor }, index, fromList, canDiscount, live, false, keepPrice);
      if (!priced) continue;
      lines.push(priced.line);
      if (priced.below) belowPrice.push(product.name);
    }
    return { lines, belowPrice, likeProduct };
  }

  /**
   * Remembers items typed in at a sale (ADR-041, ADR-049): one row per business per name, the latest unit and price,
   * and how often it sells. A retry or "ogbono" after "Ogbono" updates that row. An alias updates the item it points at.
   * Turned off with remember items: the sale is still recorded, the name is just not offered next time.
   */
  private async rememberTyped(
    tx: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    lines: { saved: boolean; description: string; unit: string; unitPrice: bigint }[],
    soldAt: Date,
    source: "typed" | "voice",
    remember: boolean,
  ) {
    if (!remember) return;
    const byKey = new Map<string, { name: string; unit: string; price: bigint; count: number }>();
    for (const line of lines) {
      if (!line.saved) continue;
      const key = savedItemKey(line.description);
      if (!key) continue;
      const seen = byKey.get(key);
      byKey.set(key, { name: seen?.name ?? line.description.trim(), unit: line.unit, price: line.unitPrice, count: (seen?.count ?? 0) + 1 });
    }
    // Typed explicitly: Postgres cannot work out the type of a bare parameter inside CASE or GREATEST.
    const when = sql`${soldAt.toISOString()}::timestamptz`;
    for (const [key, item] of byKey) {
      await this.rememberUnit(tx, tenant, businessId, item.unit);
      const [alias] = await tx
        .select()
        .from(itemAliases)
        .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, businessId), eq(itemAliases.aliasKey, key)))
        .limit(1);
      if (alias?.productId) continue;
      if (alias?.savedItemId) {
        await this.touchRemembered(tx, tenant, alias.savedItemId, item, soldAt, when);
        continue;
      }
      const named = await tx
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`lower(${products.name}) LIKE ${`${key.slice(0, 80)}%`}`))
        .limit(20);
      if (named.some((row) => savedItemKey(row.name) === key)) continue;
      const price = sql`${item.price.toString()}::bigint`;
      await tx
        .insert(savedItems)
        .values({
          id: newId(),
          tenantId: tenant.tenantId,
          businessId,
          name: item.name.slice(0, 160),
          nameKey: key,
          unit: item.unit,
          unitSet: true,
          source,
          catalogMode: "quick",
          lastPriceMinor: item.price,
          timesSold: item.count,
          firstSoldAt: soldAt,
          lastSoldAt: soldAt,
          createdBy: tenant.userId,
          updatedBy: tenant.userId,
        })
        .onConflictDoUpdate({
          target: [savedItems.tenantId, savedItems.businessId, savedItems.nameKey],
          set: {
            unit: item.unit,
            unitSet: true,
            // An older offline sale arriving late does not replace a newer price.
            lastPriceMinor: sql`CASE WHEN ${savedItems.lastSoldAt} IS NULL OR ${savedItems.lastSoldAt} <= ${when} THEN ${price} ELSE ${savedItems.lastPriceMinor} END`,
            lastSoldAt: sql`GREATEST(coalesce(${savedItems.lastSoldAt}, ${when}), ${when})`,
            firstSoldAt: sql`CASE WHEN ${savedItems.firstSoldAt} IS NULL THEN ${when} ELSE ${savedItems.firstSoldAt} END`,
            timesSold: sql`${savedItems.timesSold} + ${item.count}::integer`,
            archivedAt: null,
            updatedAt: new Date(),
            updatedBy: tenant.userId,
          },
        });
    }
  }

  private async touchRemembered(
    tx: DbExecutor,
    tenant: TenantContext,
    id: string,
    item: { unit: string; price: bigint; count: number },
    soldAt: Date,
    when: SQL,
  ) {
    const price = sql`${item.price.toString()}::bigint`;
    await tx
      .update(savedItems)
      .set({
        unit: item.unit,
        unitSet: true,
        lastPriceMinor: sql`CASE WHEN ${savedItems.lastSoldAt} IS NULL OR ${savedItems.lastSoldAt} <= ${when} THEN ${price} ELSE ${savedItems.lastPriceMinor} END`,
        lastSoldAt: sql`GREATEST(coalesce(${savedItems.lastSoldAt}, ${when}), ${when})`,
        firstSoldAt: sql`CASE WHEN ${savedItems.firstSoldAt} IS NULL OR ${savedItems.firstSoldAt} > ${when} THEN ${when} ELSE ${savedItems.firstSoldAt} END`,
        timesSold: sql`${savedItems.timesSold} + ${item.count}::integer`,
        archivedAt: null,
        updatedAt: soldAt,
        updatedBy: tenant.userId,
      })
      .where(and(eq(savedItems.id, id), eq(savedItems.tenantId, tenant.tenantId)));
  }

  /**
   * A unit typed at the counter joins the business list after two sales (ADR-053).
   * One sale can be a typo, so it stays off the list. The owner can add a unit in Settings at once.
   */
  private async rememberUnit(tx: DbExecutor, tenant: TenantContext, businessId: string, unit: string) {
    if ((UNIT_CODES as readonly string[]).includes(unit) || !FLEXIBLE_UNIT.test(unit)) return;
    const [known] = await tx
      .select({ id: businessUnits.id })
      .from(businessUnits)
      .where(and(eq(businessUnits.tenantId, tenant.tenantId), eq(businessUnits.businessId, businessId), eq(businessUnits.code, unit)))
      .limit(1);
    if (known) return;
    const [used] = await tx
      .select({ sales: sql<number>`count(distinct ${saleLines.saleId})::int` })
      .from(saleLines)
      .where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.businessId, businessId), eq(saleLines.enteredUnit, unit)));
    if (Number(used?.sales ?? 0) < 2) return;
    await tx
      .insert(businessUnits)
      .values({
        id: newId(),
        tenantId: tenant.tenantId,
        businessId,
        code: unit,
        displayName: capitaliseFirst(unit),
        standard: false,
        createdBy: tenant.userId,
      })
      .onConflictDoNothing({ target: [businessUnits.tenantId, businessUnits.businessId, businessUnits.code] });
  }

  private async insertLines(
    tx: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    saleId: string,
    lines: { product: ProductRow | null; description: string; quantity: bigint; entered: bigint; unit: string; unitPrice: bigint; lineTotal: bigint; reduction?: bigint; saved?: boolean; amount?: boolean; possibleProductId?: string | null }[],
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
          lineKind: line.product ? "product" : line.amount ? "amount" : line.saved ? "quick" : "service",
          possibleProductId: line.product ? null : (line.possibleProductId ?? null),
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

  /**
   * Sales this person may see: their shop, and then everything (sales.read.all), or their own sales plus the sales
   * waiting at their desk and the ones they handled (cashier: waiting for payment; store keeper: waiting for goods).
   */
  private scope(tenant: TenantContext, businessId: string): SQL[] {
    const filters: SQL[] = [eq(sales.tenantId, tenant.tenantId), eq(sales.businessId, businessId)];
    if (tenant.membershipBranchId) filters.push(eq(sales.branchId, tenant.membershipBranchId));
    if (tenant.permissions.includes(Permission.SALES_READ_ALL)) return filters;
    const visible: SQL[] = [eq(sales.membershipId, tenant.membershipId)];
    if (tenant.permissions.includes(Permission.SALES_COLLECT)) visible.push(eq(sales.status, "awaiting_payment"), eq(sales.collectedMembershipId, tenant.membershipId));
    if (tenant.permissions.includes(Permission.SALES_RELEASE)) visible.push(eq(sales.status, "awaiting_release"), eq(sales.releasedMembershipId, tenant.membershipId));
    filters.push(or(...visible) as SQL);
    return filters;
  }

  /** "release" is the store keeper's view: what to give out, with no amounts or customer details. */
  private viewOf(tenant: TenantContext, sale: SaleRow): "full" | "release" {
    if (tenant.permissions.includes(Permission.SALES_READ_ALL) || sale.membershipId === tenant.membershipId) return "full";
    if (tenant.permissions.includes(Permission.SALES_COLLECT) && (sale.status === "awaiting_payment" || sale.collectedMembershipId === tenant.membershipId)) return "full";
    return "release";
  }

  /** Offline sales are recorded in the shop they were made in, even after that shop has closed (ADR-050). */
  private async branchForSale(tx: DbExecutor, tenant: TenantContext, businessId: string, source: SaleSource) {
    if (source !== "offline") return resolveBranch(tx, tenant, businessId);
    // The sync already chose the shop the sale was made in, including one that has since closed.
    const branchId = tenant.branchId ?? tenant.membershipBranchId;
    if (!branchId) throw new ApiError("BRANCH_REQUIRED", "Choose a shop first.", 400);
    return findBranch(tx, tenant, businessId, branchId);
  }

  /** Sales the server could not record from a phone. The owner and managers deal with them (ADR-050). */
  async listProblems(tenant: TenantContext) {
    this.assertProblemRole(tenant);
    const business = await requireBusiness(this.db, tenant);
    const filters = [eq(syncProblems.tenantId, tenant.tenantId), eq(syncProblems.businessId, business.id), isNull(syncProblems.resolvedAt)];
    if (tenant.membershipBranchId) filters.push(eq(syncProblems.branchId, tenant.membershipBranchId));
    const rows = await this.db.select().from(syncProblems).where(and(...filters)).orderBy(desc(syncProblems.createdAt)).limit(50);
    const productIds = new Set<string>();
    for (const row of rows) {
      for (const line of problemLines(row.payload)) if (line.productId) productIds.add(line.productId);
    }
    const named =
      productIds.size === 0
        ? []
        : await this.db
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), inArray(products.id, [...productIds])));
    const names = new Map(named.map((row) => [row.id, row.name]));
    return {
      items: rows.map((row) => ({
        id: row.id,
        operationId: row.operationId,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        soldAt: typeof row.payload.soldAt === "string" ? row.payload.soldAt : null,
        summary: problemSummary(row.payload, names),
        totalMinor: problemTotal(row.payload),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Records the phone's sale as the owner, at the phone's prices and time. A later sync of the same operation is a duplicate. */
  async recordProblem(tenant: TenantContext, id: string) {
    this.assertProblemRole(tenant);
    const problem = await this.requireOpenProblem(tenant, id);
    const soldAt = typeof problem.payload.soldAt === "string" ? new Date(problem.payload.soldAt) : undefined;
    const scoped: TenantContext = {
      ...tenant,
      businessId: problem.businessId ?? tenant.businessId,
      branchId: problem.branchId ?? tenant.branchId,
      membershipBranchId: null,
    };
    const sale = await this.create(scoped, problem.payload, {
      source: "offline",
      ...(soldAt && !Number.isNaN(soldAt.getTime()) ? { soldAt } : {}),
      allowOlder: true,
    });
    const now = new Date();
    await this.db
      .update(syncProblems)
      .set({ resolvedAt: now, resolvedBy: tenant.userId, resolution: "recorded" })
      .where(and(eq(syncProblems.tenantId, tenant.tenantId), eq(syncProblems.id, problem.id)));
    await this.db
      .update(idempotencyKeys)
      .set({ status: "completed", responseStatus: 200, responseBody: { sale }, completedAt: now })
      .where(and(eq(idempotencyKeys.tenantId, tenant.tenantId), eq(idempotencyKeys.key, problem.operationId)));
    return sale;
  }

  /** The owner says this was not a sale. The reason is kept in the activity log. The sale is not recorded. */
  async dismissProblem(tenant: TenantContext, id: string, raw: unknown) {
    this.assertProblemRole(tenant);
    const { reason } = z.object({ reason: z.string().trim().min(1, "Say why this was not a sale.").max(240) }).parse(raw ?? {});
    const problem = await this.requireOpenProblem(tenant, id);
    const now = new Date();
    await this.db
      .update(syncProblems)
      .set({ resolvedAt: now, resolvedBy: tenant.userId, resolution: "not_a_sale", reason })
      .where(and(eq(syncProblems.tenantId, tenant.tenantId), eq(syncProblems.id, problem.id)));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "sale.not_a_sale",
      entityType: "sync_problem",
      entityId: problem.id,
      correlationId: tenant.correlationId,
      businessId: problem.businessId,
      branchId: problem.branchId,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { reason, operationId: problem.operationId },
    });
    return { id: problem.id, resolution: "not_a_sale" as const };
  }

  private assertProblemRole(tenant: TenantContext) {
    if (tenant.role !== "OWNER" && tenant.role !== "ADMINISTRATOR" && tenant.role !== "MANAGER") {
      throw new ApiError("FORBIDDEN", "Only the owner or a manager can deal with these sales.", 403);
    }
  }

  private async requireOpenProblem(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const [problem] = await this.db
      .select()
      .from(syncProblems)
      .where(and(eq(syncProblems.tenantId, tenant.tenantId), eq(syncProblems.businessId, business.id), eq(syncProblems.id, id)))
      .limit(1);
    if (!problem || (tenant.membershipBranchId && problem.branchId !== tenant.membershipBranchId)) {
      throw new ApiError("NOT_FOUND", "That sale was not found.", 404);
    }
    if (problem.resolvedAt) throw new ApiError("ALREADY_DEALT", "This has already been dealt with.", 409);
    return problem;
  }

  /** Serial numbers or IMEIs recorded after the sale (ADR-062). */
  async addSerials(tenant: TenantContext, id: string, raw: unknown) {
    const sale = await this.requireSale(this.db, tenant, id);
    await this.serials.addToSale(tenant, sale.id, raw, { businessId: sale.businessId, branchId: sale.branchId, customerId: sale.customerId, soldAt: sale.soldAt, status: sale.status });
    return this.get(tenant, id);
  }

  private async requireSale(executor: DbExecutor, tenant: TenantContext, id: string, lock = false): Promise<SaleRow> {
    const business = await requireBusiness(executor, tenant);
    const query = executor.select().from(sales).where(and(...this.scope(tenant, business.id), eq(sales.id, id))).limit(1);
    const [sale] = lock ? await query.for("update") : await query;
    if (!sale) throw new ApiError("NOT_FOUND", "Sale not found.", 404);
    return sale;
  }

  private async requireCustomer(tx: DbExecutor, tenant: TenantContext, businessId: string, customerId: string): Promise<CustomerRow> {
    const filters = [eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, businessId), eq(customers.id, customerId)];
    const [customer] = await tx.select().from(customers).where(and(...filters)).limit(1);
    if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404, [{ field: "customerId", message: "Not found." }]);
    return customer;
  }

  private paymentState(sale: SaleRow): "unpaid" | "paid" | "credit" {
    if (sale.status === "awaiting_payment" || (sale.status === "voided" && sale.collectedAt === null)) return "unpaid";
    return sale.balanceMinor > 0n ? "credit" : "paid";
  }

  private releaseSummary(sale: SaleRow) {
    return {
      id: sale.id,
      number: sale.saleNumber,
      invoiceNumber: sale.invoiceNumber,
      provisionalNumber: sale.provisionalNumber,
      status: sale.status as SaleStatus,
      paymentState: this.paymentState(sale),
      historyOnly: sale.historyOnly,
      soldAt: sale.soldAt,
    };
  }

  private summaryOf(sale: SaleRow) {
    return {
      id: sale.id,
      number: sale.saleNumber,
      invoiceNumber: sale.invoiceNumber,
      provisionalNumber: sale.provisionalNumber,
      externalRef: sale.externalRef,
      status: sale.status as SaleStatus,
      paymentState: this.paymentState(sale),
      historyOnly: sale.historyOnly,
      source: sale.source,
      currency: sale.currencyCode.trim(),
      subtotalMinor: sale.subtotalMinor.toString(),
      discountMinor: sale.discountMinor.toString(),
      totalMinor: sale.totalMinor.toString(),
      paidMinor: sale.paidMinor.toString(),
      balanceMinor: sale.balanceMinor.toString(),
      dueDate: sale.dueDate,
      soldAt: sale.soldAt,
      customerId: sale.customerId,
    };
  }
}

/**
 * A customer on standard credit terms (ADR-059): when money is left owing, the sale is due that many days from today
 * and needs no written comment. A date or comment the person gave is kept.
 */
function onTerms(
  payload: { payments: { amountMinor: string }[]; dueDate?: string | undefined; comment?: string | undefined },
  customer: { creditAllowed: boolean; creditTermsDays: number | null } | null | undefined,
  total: bigint,
  timeZone: string,
) {
  if (!customer?.creditAllowed || !customer.creditTermsDays) return;
  const paid = payload.payments.reduce((sum, payment) => sum + BigInt(payment.amountMinor), 0n);
  if (paid >= total) return;
  const due = new Date(`${localDate(new Date(), timeZone)}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + customer.creditTermsDays);
  payload.dueDate ??= due.toISOString().slice(0, 10);
  payload.comment ??= `On ${customer.creditTermsDays}-day terms.`;
}
