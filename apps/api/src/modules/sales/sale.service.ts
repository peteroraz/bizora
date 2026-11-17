import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  businessTypeFromIndustry,
  formatAddressDisplay,
  parseQuantity,
  Permission,
  ROLE_PERMISSIONS,
  SALE_PAGE_SIZE,
  SALE_STATUSES,
  saleCollectSchema,
  saleCommentSchema,
  saleCreateSchema,
  saleReleaseSchema,
  saleVoidSchema,
  whatsAppHref,
  type SaleCreateInput,
  type SaleStatus,
} from "@bizora/contracts";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { addresses, branches, businesses, customerPayments, customers, paymentAllocations, memberships, products, saleComments, saleLines, salePayments, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { findBranch, productUnitsFor, requireBusiness, resolveBranch, unitFactor, type BusinessRow, type ProductRow } from "../inventory/inventory-scope.js";
import { StockService } from "../inventory/stock.service.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { BrandingService } from "../branding/branding.service.js";
import { availableDocuments, documentModel, renderPdf, type DocumentInput, type SaleDocumentType } from "./sale-document.js";

type SaleRow = typeof sales.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type BranchRow = typeof branches.$inferSelect;
export type SaleSource = "pos" | "offline" | "import" | "capture";
type Payment = { method: "cash" | "transfer" | "pos"; amountMinor: string; reference?: string | undefined };

const SEVEN_DAYS_MS = 7 * 86_400_000;

const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);

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
      const branch = await resolveBranch(tx, tenant, business.id);
      const customer = payload.customerId ? await this.requireCustomer(tx, tenant, business.id, payload.customerId) : null;
      const lines = await this.priceLines(tx, tenant, business, payload);
      // Imports are past records, so they are never sent to a cashier.
      const desk = business.salesFlow === "desk" && source !== "import" && source !== "capture";

      const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0n);
      const discount = payload.discountMinor ? BigInt(payload.discountMinor) : 0n;
      if (discount > 0n && !tenant.permissions.includes(Permission.SALES_DISCOUNT)) {
        throw new ApiError("FORBIDDEN", "Ask a manager to give a discount.", 403, [{ field: "discountMinor", message: "Remove the discount." }]);
      }
      if (discount > subtotal) throw new ApiError("VALIDATION_ERROR", "The discount is more than the sale.", 400, [{ field: "discountMinor", message: "Too large." }]);
      const total = subtotal - discount;
      if (desk && payload.payments.length > 0) {
        throw new ApiError("PAY_AT_CASHIER", "In this shop the cashier takes payment. Send the sale to the cashier.", 400, [{ field: "payments", message: "Leave empty." }]);
      }

      // Desk: the customer takes an invoice to the cashier; the receipt number comes with the payment (ADR-017).
      const receiptNumber = desk ? null : (await this.numbers.next(tx, tenant.tenantId, business.id, "receipt")).number;
      const now = new Date();
      const settled = desk
        ? null
        : await this.settle(tx, tenant, business, branch, {
            id,
            number: receiptNumber ?? "",
            subtotal,
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
      if (settled) {
        await this.insertPayments(tx, tenant, business.id, id, payload.payments);
        await this.takeStock(tx, tenant, business, branch, id, receiptNumber ?? "", soldAt);
      }
      if (payload.comment) await this.addComment(tx, tenant, business.id, id, payload.comment, settled && settled.balance > 0n ? "credit" : "comment");
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
    });
    return this.get(tenant, id);
  }

  /** The cashier takes the money, or gives credit to an approved customer, for a sale from the sales desk. */
  async collect(tenant: TenantContext, id: string, raw: unknown) {
    const payload = saleCollectSchema.parse(raw ?? {});
    await this.db.transaction(async (tx) => {
      const sale = await this.requireSale(tx, tenant, id, true);
      if (sale.status !== "awaiting_payment") throw new ApiError("NOT_AWAITING_PAYMENT", "This sale is not waiting for payment.", 409);
      const business = await requireBusiness(tx, tenant);
      const branch = await findBranch(tx, tenant, business.id, sale.branchId);
      const customerId = payload.customerId ?? sale.customerId;
      const customer = customerId ? await this.requireCustomer(tx, tenant, business.id, customerId) : null;
      const now = new Date();
      const receiptNumber = sale.saleNumber ?? (await this.numbers.next(tx, tenant.tenantId, business.id, "receipt")).number;
      const settled = await this.settle(tx, tenant, business, branch, {
        id: sale.id,
        number: receiptNumber,
        subtotal: sale.subtotalMinor,
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
      await this.insertPayments(tx, tenant, business.id, sale.id, payload.payments);
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
      await this.takeStock(tx, tenant, business, branch, sale.id, sale.saleNumber ?? sale.invoiceNumber ?? "", now);
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
      const business = await requireBusiness(tx, tenant);
      const today = localDate(new Date(), business.timezone);
      if (!sale.historyOnly && sale.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, sale.journalEntryId, { entryDate: today, reason: `Sale ${sale.saleNumber ?? sale.invoiceNumber} cancelled: ${reason}` });
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
  async list(tenant: TenantContext, query: { date?: string; page?: number; status?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const filters = this.scope(tenant, business.id);
    const status = SALE_STATUSES.find((item) => item === query.status);
    const day = this.day(business, query.date);
    if (status) filters.push(eq(sales.status, status));
    else filters.push(gte(sales.soldAt, day.start), lt(sales.soldAt, day.end));
    const page = Math.max(1, query.page ?? 1);
    const [count] = await this.db.select({ total: sql<number>`count(*)::int` }).from(sales).where(and(...filters));
    const rows = await this.db
      .select({
        sale: sales,
        customerName: customers.name,
        byName: users.displayName,
        itemCount: sql<number>`(SELECT count(*)::int FROM sale_lines WHERE sale_lines.tenant_id = ${sales.tenantId} AND sale_lines.sale_id = ${sales.id})`,
      })
      .from(sales)
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(users, eq(users.id, sales.createdBy))
      .where(and(...filters))
      .orderBy(...(status ? [asc(sales.createdAt), asc(sales.id)] : [desc(sales.soldAt), desc(sales.id)]))
      .limit(SALE_PAGE_SIZE)
      .offset((page - 1) * SALE_PAGE_SIZE);
    return {
      date: status ? null : day.date,
      status: status ?? null,
      page,
      pageSize: SALE_PAGE_SIZE,
      total: Number(count?.total ?? 0),
      items: rows.map(({ sale, customerName, byName, itemCount }) =>
        this.viewOf(tenant, sale) === "full"
          ? { ...this.summaryOf(sale), customerName, byName, itemCount: Number(itemCount), view: "full" as const }
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
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const seeContact = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const receiptPath = `/r/${sale.receiptToken}`;
    const documents = availableDocuments(sale);
    const label = documents.includes("receipt") ? `Receipt ${sale.saleNumber}` : sale.balanceMinor > 0n || !sale.collectedAt ? `Invoice ${sale.invoiceNumber ?? ""}` : `Receipt ${sale.saleNumber ?? ""}`;
    const message = `${label} from ${extra?.businessName ?? ""}. View or download it here: `;
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
      // Debtor payments made after the sale (ADR-019).
      laterPayments: laterPayments.map((payment) => ({ id: payment.id, number: payment.number, method: payment.method, amountMinor: payment.amount.toString(), receivedAt: payment.receivedAt })),
    };
  }

  private laterPayments(sale: SaleRow) {
    return this.db
      .select({ id: customerPayments.id, number: customerPayments.paymentNumber, method: customerPayments.method, amount: paymentAllocations.amountMinor, receivedAt: customerPayments.receivedAt })
      .from(paymentAllocations)
      .innerJoin(customerPayments, and(eq(customerPayments.tenantId, paymentAllocations.tenantId), eq(customerPayments.id, paymentAllocations.paymentId)))
      .where(and(eq(paymentAllocations.tenantId, sale.tenantId), eq(paymentAllocations.saleId, sale.id), eq(customerPayments.status, "recorded")))
      .orderBy(asc(customerPayments.receivedAt));
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
        servedBy: name(sale.createdBy),
        cashier: name(sale.collectedBy),
      })
      .from(sales)
      .innerJoin(businesses, and(eq(businesses.tenantId, sales.tenantId), eq(businesses.id, sales.businessId)))
      .innerJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
      .leftJoin(addresses, and(eq(addresses.tenantId, branches.tenantId), eq(addresses.id, branches.addressId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .where(and(eq(sales.tenantId, sale.tenantId), eq(sales.id, sale.id)))
      .limit(1);
    if (!extra) throw new ApiError("NOT_FOUND", "Sale not found.", 404);
    const [lines, payments] = await Promise.all([
      this.db.select().from(saleLines).where(and(eq(saleLines.tenantId, sale.tenantId), eq(saleLines.saleId, sale.id))).orderBy(asc(saleLines.lineNo)),
      this.db.select().from(salePayments).where(and(eq(salePayments.tenantId, sale.tenantId), eq(salePayments.saleId, sale.id))).orderBy(asc(salePayments.createdAt)),
    ]);
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
      business: { name: extra.business.name, phone: extra.business.phoneE164, timezone: extra.business.timezone },
      branch: { name: extra.branch.name, address: address || null, phone: extra.branch.phoneE164 },
      customerName: extra.customerName,
      servedBy: extra.servedBy,
      cashier: extra.cashier,
      lines: lines.map((line) => ({
        description: line.description,
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
    if (balance > 0n) {
      const customer = input.customer;
      if (!customer) {
        throw new ApiError("CUSTOMER_REQUIRED", "Choose the customer who will owe the balance.", 400, [{ field: "customerId", message: "Required for credit." }]);
      }
      const manager = tenant.permissions.includes(Permission.DEBTORS_MANAGE);
      if (!manager && !tenant.permissions.includes(Permission.SALES_CREDIT)) {
        throw new ApiError("FORBIDDEN", "You cannot sell on credit. Take full payment, or send the sale to the cashier.", 403, [{ field: "payments", message: "Full payment needed." }]);
      }
      // Imported or captured records were already agreed with the customer; they skip approval checks (ADR-015, ADR-018).
      if (input.source !== "import" && input.source !== "capture") {
        if (!customer.creditAllowed) {
          throw new ApiError("CREDIT_NOT_APPROVED", `${customer.name} is not approved for credit. A manager or owner can approve them on the customer's page.`, 403, [
            { field: "customerId", message: "Not approved for credit." },
          ]);
        }
        if (customer.creditLimitMinor !== null) {
          const owing = await this.owing(tx, tenant.tenantId, customer.id);
          if (owing + balance > customer.creditLimitMinor) {
            if (!manager) {
              throw new ApiError("OVER_CREDIT_LIMIT", `This would take ${customer.name} over their credit limit. Take more payment or ask a manager.`, 403, [
                { field: "payments", message: "Over the credit limit." },
              ]);
            }
            overLimit = true;
          }
        }
        if (!input.dueDate) throw new ApiError("DUE_DATE_REQUIRED", "Enter the date the customer will pay.", 400, [{ field: "dueDate", message: "Required for credit." }]);
        if (input.dueDate < localDate(new Date(), business.timezone)) {
          throw new ApiError("VALIDATION_ERROR", "The payment date cannot be in the past.", 400, [{ field: "dueDate", message: "In the past." }]);
        }
        if (!input.comment) throw new ApiError("COMMENT_REQUIRED", "Write a comment for this credit: why, and how the customer will pay.", 400, [{ field: "comment", message: "Required for credit." }]);
      }
    }

    const income = businessTypeFromIndustry(business.industryCode) === "services" ? "service_income" : "sales";
    const posting: PostingLine[] = [];
    const methodAccount = { cash: { role: "cash" as const, branchId: branch.id }, transfer: { role: "bank" as const }, pos: { role: "pos_clearing" as const } };
    for (const [method, amount] of paidByMethod) {
      if (amount > 0n) posting.push({ account: methodAccount[method as keyof typeof methodAccount], debitMinor: amount, memo: method });
    }
    if (balance > 0n) posting.push({ account: { role: "debtors" }, debitMinor: balance, memo: "Owed by customer" });
    if (input.discount > 0n) posting.push({ account: { role: "discounts" }, debitMinor: input.discount });
    if (input.subtotal > 0n) posting.push({ account: { role: income }, creditMinor: input.subtotal });
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
    return { paid, balance, journalEntryId, overLimit };
  }

  /** Takes the sale's goods out of stock (counted products only) and remembers each line's cost. */
  private async takeStock(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, branch: BranchRow, saleId: string, number: string, occurredAt: Date) {
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
      });
      await tx
        .update(saleLines)
        .set({ stockMovementId: movement.id, costMinor: -movement.valueMinor })
        .where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.id, line.id)));
    }
  }

  private async insertPayments(tx: DbExecutor, tenant: TenantContext, businessId: string, saleId: string, payments: Payment[]) {
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
      })),
    );
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
