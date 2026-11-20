import { Inject, Injectable } from "@nestjs/common";
import {
  checkPhone,
  JOB_MAX_DAYS_BACK,
  JOB_PAGE_SIZE,
  jobAddLinesSchema,
  jobCancelSchema,
  jobCreateSchema,
  jobFinishSchema,
  jobPayDaySchema,
  jobRemoveLineSchema,
  jobUpdateSchema,
  parseQuantity,
  Permission,
  phoneProblemMessage,
  stockReceiveSchema,
  type JobLineInput,
} from "@bizora/contracts";
import { and, asc, desc, eq, ilike, inArray, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate, zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { customerPayments, customers, jobLines, jobs, products, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { PaymentService } from "../debtors/payment.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { productUnitsFor, requireBusiness, resolveBranch, unitFactor, type BranchRow, type BusinessRow, type ProductRow } from "../inventory/inventory-scope.js";
import { StockService } from "../inventory/stock.service.js";
import { LedgerPostingService } from "../ledger/ledger-posting.service.js";
import { SaleService } from "../sales/sale.service.js";

type JobRow = typeof jobs.$inferSelect;
type LineRow = typeof jobLines.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type Scope = { business: BusinessRow; branch: BranchRow; job: JobRow };

const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Jobs for customers (ADR-035): a mechanic's job card, a tailor's order, an electrician's or plumber's job. The job
 * collects the work, parts from stock, parts bought for it and what helpers were paid. Money taken before it is
 * finished is a deposit; finishing it bills the customer, takes the deposits off and leaves the rest owed, paid
 * later against this job (never against older debts).
 */
@Injectable()
export class JobService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(SaleService) private readonly sales: SaleService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // Reading -------------------------------------------------------------------------------------------------------

  async list(tenant: TenantContext, query: { status?: string; customerId?: string; q?: string; page?: number }) {
    const business = await requireBusiness(this.db, tenant);
    const filters: SQL[] = [eq(jobs.tenantId, tenant.tenantId), eq(jobs.businessId, business.id)];
    const shop = tenant.membershipBranchId ?? tenant.branchId;
    if (shop) filters.push(eq(jobs.branchId, shop));
    if (query.status === "open" || query.status === "done" || query.status === "cancelled") filters.push(eq(jobs.status, query.status));
    if (query.customerId) filters.push(eq(jobs.customerId, query.customerId));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      filters.push(or(ilike(jobs.jobNumber, like), ilike(jobs.title, like), ilike(customers.name, like)) as SQL);
    }
    const page = Math.max(1, query.page ?? 1);
    const charged = sql<string>`coalesce((SELECT sum(l.line_total_minor) FROM job_lines l WHERE l.tenant_id = ${jobs.tenantId} AND l.job_id = ${jobs.id} AND l.removed_at IS NULL), 0)::text`;
    const deposited = sql<string>`coalesce((SELECT sum(p.amount_minor) FROM customer_payments p WHERE p.tenant_id = ${jobs.tenantId} AND p.job_id = ${jobs.id} AND p.status = 'recorded'), 0)::text`;
    const rows = await this.db
      .select({ job: jobs, customerName: customers.name, charged, deposited, saleTotal: sales.totalMinor, saleBalance: sales.balanceMinor })
      .from(jobs)
      .innerJoin(customers, and(eq(customers.tenantId, jobs.tenantId), eq(customers.id, jobs.customerId)))
      .leftJoin(sales, and(eq(sales.tenantId, jobs.tenantId), eq(sales.id, jobs.saleId)))
      .where(and(...filters))
      .orderBy(desc(jobs.openedOn), desc(jobs.createdAt))
      .limit(JOB_PAGE_SIZE + 1)
      .offset((page - 1) * JOB_PAGE_SIZE);
    return {
      page,
      hasMore: rows.length > JOB_PAGE_SIZE,
      items: rows.slice(0, JOB_PAGE_SIZE).map((row) => {
        const total = row.saleTotal ?? BigInt(row.charged);
        const left = row.saleBalance ?? total - BigInt(row.deposited);
        return {
          id: row.job.id,
          number: row.job.jobNumber,
          title: row.job.title,
          status: row.job.status,
          customer: { id: row.job.customerId, name: row.customerName },
          openedOn: row.job.openedOn,
          promisedOn: row.job.promisedOn,
          chargedMinor: total.toString(),
          paidMinor: (total - left).toString(),
          leftMinor: (left > 0n ? left : 0n).toString(),
        };
      }),
    };
  }

  async get(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const job = await this.requireJob(this.db, tenant, business.id, id);
    const [customer] = await this.db.select().from(customers).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.id, job.customerId))).limit(1);
    const lines = await this.db.select().from(jobLines).where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.jobId, job.id))).orderBy(asc(jobLines.lineNo));
    const deposits = await this.db
      .select()
      .from(customerPayments)
      .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.jobId, job.id)))
      .orderBy(asc(customerPayments.receivedAt));
    const [sale] = job.saleId ? await this.db.select().from(sales).where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, job.saleId))).limit(1) : [];
    const people = [...new Set(lines.map((line) => line.createdBy).concat(job.createdBy))];
    const names = new Map((await this.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, people))).map((row) => [row.id, row.name]));
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    const active = lines.filter((line) => !line.removedAt);
    const charged = active.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
    const costs = active.reduce((sum, line) => sum + line.costMinor, 0n);
    const deposited = deposits.filter((payment) => payment.status === "recorded").reduce((sum, payment) => sum + payment.amountMinor, 0n);
    const total = sale?.totalMinor ?? charged;
    const left = sale ? sale.balanceMinor : charged - deposited;
    return {
      job: {
        id: job.id,
        number: job.jobNumber,
        title: job.title,
        problem: job.problem,
        summary: job.summary,
        status: job.status,
        openedOn: job.openedOn,
        promisedOn: job.promisedOn,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        cancelledAt: job.cancelledAt?.toISOString() ?? null,
        cancelReason: job.cancelReason,
        createdBy: names.get(job.createdBy) ?? null,
      },
      customer: customer ? { id: customer.id, name: customer.name, phone: customer.phoneE164 } : null,
      lines: lines.map((line) => ({
        id: line.id,
        kind: line.kind,
        description: line.description,
        productId: line.productId,
        quantity: line.enteredQuantity.toString(),
        unit: line.enteredUnit,
        unitPriceMinor: line.unitPriceMinor.toString(),
        totalMinor: line.lineTotalMinor.toString(),
        ...(seeCost || line.kind === "helper" || line.kind === "bought" ? { costMinor: line.costMinor.toString() } : {}),
        paidFrom: line.paidFrom,
        supplier: line.supplier,
        usedOn: line.usedOn,
        addedBy: names.get(line.createdBy) ?? null,
        removed: line.removedAt ? { at: line.removedAt.toISOString(), reason: line.removeReason } : null,
      })),
      payments: deposits.map((payment) => ({
        id: payment.id,
        number: payment.paymentNumber,
        method: payment.method,
        amountMinor: payment.amountMinor.toString(),
        receivedAt: payment.receivedAt.toISOString(),
        status: payment.status,
        confirmation: payment.confirmation,
        receiptToken: payment.status === "recorded" ? payment.receiptToken : null,
      })),
      sale: sale
        ? { id: sale.id, number: sale.saleNumber, invoiceNumber: sale.invoiceNumber, totalMinor: sale.totalMinor.toString(), paidMinor: sale.paidMinor.toString(), balanceMinor: sale.balanceMinor.toString(), dueDate: sale.dueDate, receiptToken: sale.receiptToken }
        : null,
      totals: {
        chargedMinor: total.toString(),
        depositsMinor: deposited.toString(),
        paidMinor: (total - left).toString(),
        leftMinor: left.toString(),
        ...(seeCost ? { costMinor: costs.toString(), profitMinor: (total - costs).toString() } : {}),
      },
    };
  }

  /** Regular jobs saved for quick picking: products that keep no stock, with their usual price. */
  async regulars(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select({ id: products.id, name: products.name, priceMinor: products.priceMinor })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), eq(products.trackStock, false), isNull(products.archivedAt)))
      .orderBy(asc(products.name))
      .limit(500);
    return { items: rows.map((row) => ({ id: row.id, name: row.name, priceMinor: row.priceMinor?.toString() ?? null })) };
  }

  // Changing ------------------------------------------------------------------------------------------------------

  /** Opens a job: the customer (found or added), what is being worked on, the first lines and any money taken. */
  async create(tenant: TenantContext, raw: unknown) {
    const payload = jobCreateSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(jobs).where(eq(jobs.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    if (payload.payment) this.assertCanTakeMoney(tenant);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id);
      const when = this.when(business, payload.day);
      const customer = await this.customerFor(tx, tenant, business, branch, payload);
      const number = (await this.numbers.next(tx, tenant.tenantId, business.id, "job")).number;
      const [job] = await tx
        .insert(jobs)
        .values({
          id,
          tenantId: tenant.tenantId,
          businessId: business.id,
          branchId: branch.id,
          customerId: customer.id,
          jobNumber: number,
          title: payload.title || null,
          problem: payload.problem || null,
          summary: payload.summary || null,
          openedOn: when.day,
          promisedOn: payload.promisedOn ?? null,
          createdBy: tenant.userId,
          membershipId: tenant.membershipId,
        })
        .returning();
      const scope = { business, branch, job: job as JobRow };
      await this.record(tx, tenant, scope, "job.opened", { number, customer: customer.name, lines: payload.lines.length });
      if (payload.lines.length > 0) await this.addLinesIn(tx, tenant, scope, payload.lines, when);
      if (payload.payment) {
        await this.payments.recordDeposit(tx, tenant, {
          business,
          branchId: branch.id,
          customer,
          job: { id, number },
          amount: BigInt(payload.payment.amountMinor),
          method: payload.payment.method,
          reference: payload.payment.reference,
          receivedAt: when.at,
        });
      }
      if (payload.finish) await this.finishIn(tx, tenant, scope, customer, { dueDate: payload.dueDate ?? null, when });
    });
    return this.get(tenant, id);
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const payload = jobUpdateSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      if (scope.job.status === "cancelled") throw new ApiError("JOB_CANCELLED", "This job was cancelled.", 409);
      await tx
        .update(jobs)
        .set({
          ...(payload.title !== undefined ? { title: payload.title || null } : {}),
          ...(payload.problem !== undefined ? { problem: payload.problem || null } : {}),
          ...(payload.promisedOn !== undefined ? { promisedOn: payload.promisedOn } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(jobs.tenantId, tenant.tenantId), eq(jobs.id, scope.job.id)));
      await this.record(tx, tenant, scope, "job.updated", payload);
    });
    return this.get(tenant, id);
  }

  async addLines(tenant: TenantContext, id: string, raw: unknown) {
    const payload = jobAddLinesSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      this.assertOpen(scope.job);
      await this.addLinesIn(tx, tenant, scope, payload.lines, this.when(scope.business, payload.day));
    });
    return this.get(tenant, id);
  }

  /** Takes a line off an open job: parts go back on the shelf, a helper's pay is reversed. */
  async removeLine(tenant: TenantContext, id: string, lineId: string, raw: unknown) {
    const { reason } = jobRemoveLineSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      this.assertOpen(scope.job);
      const [line] = await tx
        .select()
        .from(jobLines)
        .where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.jobId, scope.job.id), eq(jobLines.id, lineId)))
        .for("update")
        .limit(1);
      if (!line) throw new ApiError("NOT_FOUND", "That line was not found.", 404);
      if (line.removedAt) throw new ApiError("ALREADY_REMOVED", "That line was already removed.", 409);
      if (line.createdBy !== tenant.userId && !tenant.permissions.includes(Permission.SALES_VOID)) {
        throw new ApiError("FORBIDDEN", "Ask a manager to remove a line someone else added.", 403);
      }
      const today = localDate(new Date(), scope.business.timezone);
      if ((line.kind === "part" || line.kind === "bought") && line.productId && line.stockMovementId) {
        const product = await this.product(tx, tenant, scope.business.id, line.productId);
        await this.stock.applyMovement(tx, { tenant, business: scope.business, branch: scope.branch, product }, {
          type: "job_return",
          quantity: line.quantity,
          enteredQuantity: line.enteredQuantity,
          enteredUnit: line.enteredUnit,
          valueMinor: line.costMinor,
          note: `${scope.job.jobNumber}: ${reason}`.slice(0, 240),
        });
      }
      if (line.kind === "helper" && line.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, line.journalEntryId, {
          entryDate: today,
          reason: `${scope.job.jobNumber}: ${line.description} removed: ${reason}`,
        });
      }
      await tx
        .update(jobLines)
        .set({ removedAt: new Date(), removedBy: tenant.userId, removeReason: reason })
        .where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.id, line.id)));
      await this.record(tx, tenant, scope, "job.line_removed", { line: line.description, kind: line.kind, reason });
    });
    return this.get(tenant, id);
  }

  /** Money from the customer: a deposit while the job is open, a payment on this job's bill once it is finished. */
  async pay(tenant: TenantContext, id: string, raw: unknown) {
    const payload = jobPayDaySchema.parse(raw);
    this.assertCanTakeMoney(tenant);
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      const when = this.when(scope.business, payload.day);
      const customer = await this.customer(tx, tenant, scope.job.customerId);
      if (scope.job.status === "cancelled") throw new ApiError("JOB_CANCELLED", "This job was cancelled.", 409);
      if (scope.job.status === "open") {
        await this.payments.recordDeposit(tx, tenant, {
          business: scope.business,
          branchId: scope.branch.id,
          customer,
          job: { id: scope.job.id, number: scope.job.jobNumber },
          amount: BigInt(payload.amountMinor),
          method: payload.method,
          reference: payload.reference,
          receivedAt: when.at,
        });
        return;
      }
      // Paid against this job only, not the customer's older debts.
      await this.payments.recordIn(tx, tenant, customer.id, {
        id: newId(),
        amount: BigInt(payload.amountMinor),
        method: payload.method,
        reference: payload.reference,
        note: `Payment on ${scope.job.jobNumber}`,
        saleId: scope.job.saleId ?? undefined,
        receivedAt: when.at,
        source: "pos",
      });
    });
    return this.get(tenant, id);
  }

  async finish(tenant: TenantContext, id: string, raw: unknown) {
    const payload = jobFinishSchema.parse(raw ?? {});
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      this.assertOpen(scope.job);
      const customer = await this.customer(tx, tenant, scope.job.customerId);
      await this.finishIn(tx, tenant, scope, customer, { dueDate: payload.dueDate ?? null, when: this.when(scope.business, payload.day) });
    });
    return this.get(tenant, id);
  }

  async cancel(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = jobCancelSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, tenant, id);
      this.assertOpen(scope.job);
      if (scope.job.createdBy !== tenant.userId && !tenant.permissions.includes(Permission.SALES_VOID)) {
        throw new ApiError("FORBIDDEN", "Ask a manager to cancel a job someone else opened.", 403);
      }
      const [lines] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(jobLines)
        .where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.jobId, scope.job.id), isNull(jobLines.removedAt)));
      const [money] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(customerPayments)
        .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.jobId, scope.job.id), eq(customerPayments.status, "recorded")));
      if ((lines?.n ?? 0) > 0 || (money?.n ?? 0) > 0) {
        throw new ApiError("JOB_NOT_EMPTY", "Remove the job's lines and cancel its deposits first, so stock and money are put right.", 409);
      }
      await tx
        .update(jobs)
        .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: tenant.userId, cancelReason: reason, updatedAt: new Date() })
        .where(and(eq(jobs.tenantId, tenant.tenantId), eq(jobs.id, scope.job.id)));
      await this.record(tx, tenant, scope, "job.cancelled", { reason });
    });
    return this.get(tenant, id);
  }

  // Inside a transaction ------------------------------------------------------------------------------------------

  private async addLinesIn(tx: DbExecutor, tenant: TenantContext, scope: Scope, inputs: JobLineInput[], when: { day: string; at: Date }) {
    const canDiscount = tenant.permissions.includes(Permission.SALES_DISCOUNT);
    const [last] = await tx.select({ n: max(jobLines.lineNo) }).from(jobLines).where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.jobId, scope.job.id)));
    let lineNo = (last?.n ?? 0) + 1;
    const context = (product: ProductRow) => ({ tenant, business: scope.business, branch: scope.branch, product });
    for (const [index, input] of inputs.entries()) {
      const field = (name: string) => `lines.${index}.${name}`;
      const lineId = newId();
      const base = { id: lineId, tenantId: tenant.tenantId, businessId: scope.business.id, jobId: scope.job.id, lineNo, kind: input.kind, usedOn: when.day, createdBy: tenant.userId };
      if (input.kind === "work") {
        const entered = parseQuantity(input.quantity) as bigint;
        const unitPrice = BigInt(input.unitPriceMinor);
        if (unitPrice === 0n && !canDiscount) throw new ApiError("FORBIDDEN", `Ask a manager to do "${input.description}" free.`, 403, [{ field: field("unitPriceMinor"), message: "Enter the price." }]);
        let productId = input.productId ?? null;
        if (productId) await this.product(tx, tenant, scope.business.id, productId);
        else if (input.save) productId = (await this.saveRegular(tx, tenant, scope.business.id, input.description, unitPrice)).id;
        await tx.insert(jobLines).values({
          ...base,
          description: input.description,
          productId,
          quantity: entered,
          enteredQuantity: entered,
          enteredUnit: "piece",
          unitPriceMinor: unitPrice,
          lineTotalMinor: round(unitPrice * entered, 1000n),
        });
      } else if (input.kind === "part") {
        const product = await this.product(tx, tenant, scope.business.id, input.productId);
        if (!product.trackStock) throw new ApiError("VALIDATION_ERROR", `${product.name} keeps no stock. Add it as work done.`, 400, [{ field: field("productId"), message: "Add as work." }]);
        const units = (await productUnitsFor(tx, tenant.tenantId, [product.id])).get(product.id) ?? [];
        const factor = unitFactor(product, units, input.unit);
        const entered = parseQuantity(input.quantity) as bigint;
        const quantity = round(entered * factor, 1000n);
        const pack = units.find((unit) => unit.unitCode === input.unit);
        const listPrice = input.unit === product.baseUnit ? product.priceMinor : (pack?.priceMinor ?? (product.priceMinor !== null ? round(product.priceMinor * factor, 1000n) : null));
        const unitPrice = input.unitPriceMinor !== undefined ? BigInt(input.unitPriceMinor) : listPrice;
        if (unitPrice === null) throw new ApiError("PRICE_REQUIRED", `Enter what you charge for ${product.name}.`, 400, [{ field: field("unitPriceMinor"), message: "Price needed." }]);
        if (listPrice !== null && unitPrice < listPrice && !canDiscount) {
          throw new ApiError("FORBIDDEN", `Ask a manager to charge less than the price for ${product.name}.`, 403, [{ field: field("unitPriceMinor"), message: "Below the price." }]);
        }
        const movement = await this.stock.applyMovement(tx, context(product), {
          type: "job_use",
          quantity: -quantity,
          enteredQuantity: entered,
          enteredUnit: input.unit,
          note: scope.job.jobNumber,
          occurredAt: when.at,
          mayGoBelowZero: false,
        });
        await tx.insert(jobLines).values({
          ...base,
          description: product.name,
          productId: product.id,
          quantity,
          enteredQuantity: entered,
          enteredUnit: input.unit,
          unitPriceMinor: unitPrice,
          lineTotalMinor: round(unitPrice * entered, 1000n),
          costMinor: -movement.valueMinor,
          stockMovementId: movement.id,
        });
      } else if (input.kind === "bought") {
        const entered = parseQuantity(input.quantity) as bigint;
        const cost = BigInt(input.costMinor);
        if (input.paidFrom === "owed" && !input.supplier) {
          throw new ApiError("VALIDATION_ERROR", `Say where ${input.description} was bought, so you know who is owed.`, 400, [{ field: field("supplier"), message: "Who is owed?" }]);
        }
        const product = input.productId ? await this.product(tx, tenant, scope.business.id, input.productId) : await this.boughtProduct(tx, tenant, scope.business.id, input.description, input.unit);
        if (!product.trackStock) throw new ApiError("VALIDATION_ERROR", `${product.name} keeps no stock. Choose another name.`, 400, [{ field: field("description"), message: "Keeps no stock." }]);
        const received = await this.stock.receiveIn(
          tx,
          tenant,
          stockReceiveSchema.parse({
            productId: product.id,
            branchId: scope.branch.id,
            quantity: input.quantity,
            unit: input.unit,
            totalCostMinor: input.costMinor,
            paidFrom: input.paidFrom === "owed" ? "credit" : input.paidFrom,
            ...(input.supplier ? { supplier: input.supplier } : {}),
            note: `For ${scope.job.jobNumber}`,
          }),
          { occurredAt: when.at },
        );
        const units = (await productUnitsFor(tx, tenant.tenantId, [product.id])).get(product.id) ?? [];
        const quantity = round(entered * unitFactor(product, units, input.unit), 1000n);
        // Used on the job at exactly what was paid for it.
        const movement = await this.stock.applyMovement(tx, context(product), {
          type: "job_use",
          quantity: -quantity,
          enteredQuantity: entered,
          enteredUnit: input.unit,
          valueMinor: -cost,
          note: scope.job.jobNumber,
          occurredAt: when.at,
          mayGoBelowZero: false,
        });
        const lineTotal = input.chargeMinor !== undefined ? BigInt(input.chargeMinor) : cost;
        const unitPrice = round(lineTotal * 1000n, entered);
        if (lineTotal < cost && !canDiscount) {
          throw new ApiError("FORBIDDEN", `Ask a manager to charge less than ${input.description} cost.`, 403, [{ field: field("chargeMinor"), message: "Below cost." }]);
        }
        // The last cost and price fill in next time it is picked.
        await tx
          .update(products)
          .set({ defaultCostMinor: round(cost * 1000n, quantity > 0n ? quantity : 1n), ...(product.priceMinor === null && input.unit === product.baseUnit ? { priceMinor: unitPrice } : {}), updatedAt: new Date() })
          .where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, product.id)));
        await tx.insert(jobLines).values({
          ...base,
          description: input.description,
          productId: product.id,
          quantity,
          enteredQuantity: entered,
          enteredUnit: input.unit,
          unitPriceMinor: unitPrice,
          lineTotalMinor: lineTotal,
          costMinor: cost,
          paidFrom: input.paidFrom,
          supplier: input.supplier ?? null,
          stockMovementId: movement.id,
          receivedMovementId: received.id,
        });
      } else {
        const cost = BigInt(input.costMinor);
        const credit = input.paidFrom === "cash" ? { role: "cash" as const, branchId: scope.branch.id } : input.paidFrom === "bank" ? { role: "bank" as const } : { role: "payable" as const };
        const posted = await this.ledger.post(
          tx,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          {
            businessId: scope.business.id,
            branchId: scope.branch.id,
            entryDate: when.day,
            source: { type: "job_cost", id: lineId },
            postingKey: `job_cost:${lineId}`,
            description: `${scope.job.jobNumber}: ${input.description}`.slice(0, 240),
            lines: [
              { account: { role: "jobs_in_progress" }, debitMinor: cost, memo: scope.job.jobNumber },
              { account: credit, creditMinor: cost, memo: input.description.slice(0, 240) },
            ],
          },
        );
        await tx.insert(jobLines).values({
          ...base,
          description: input.description,
          quantity: 1000n,
          enteredQuantity: 1000n,
          enteredUnit: "piece",
          costMinor: cost,
          paidFrom: input.paidFrom,
          journalEntryId: posted.entryId,
        });
      }
      lineNo += 1;
    }
    await this.record(tx, tenant, scope, "job.lines_added", { count: inputs.length, kinds: inputs.map((input) => input.kind), day: when.day });
  }

  private async finishIn(tx: DbExecutor, tenant: TenantContext, scope: Scope, customer: CustomerRow, options: { dueDate: string | null; when: { day: string; at: Date } }) {
    const lines = await tx
      .select()
      .from(jobLines)
      .where(and(eq(jobLines.tenantId, tenant.tenantId), eq(jobLines.jobId, scope.job.id), isNull(jobLines.removedAt)))
      .orderBy(asc(jobLines.lineNo));
    if (lines.length === 0) throw new ApiError("JOB_EMPTY", "Add the work done before finishing the job.", 400);
    if (options.when.day < scope.job.openedOn) throw new ApiError("VALIDATION_ERROR", "A job cannot finish before the day it came in.", 400, [{ field: "day", message: "Too early." }]);
    const deposits = await tx
      .select({ id: customerPayments.id, amount: customerPayments.amountMinor })
      .from(customerPayments)
      .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.jobId, scope.job.id), eq(customerPayments.status, "recorded")))
      .for("update");
    const billed = lines.filter((line): line is LineRow & { kind: "work" | "part" | "bought" } => line.kind !== "helper");
    const bill = await this.sales.recordJobBill(tx, tenant, {
      business: scope.business,
      branch: scope.branch,
      customer,
      job: { id: scope.job.id, number: scope.job.jobNumber, title: scope.job.title },
      lines: billed.map((line) => ({
        kind: line.kind,
        productId: line.productId,
        description: line.description,
        quantity: line.quantity,
        entered: line.enteredQuantity,
        unit: line.enteredUnit,
        unitPrice: line.unitPriceMinor,
        lineTotal: line.lineTotalMinor,
        cost: line.costMinor,
        stockMovementId: line.stockMovementId,
      })),
      costTotal: lines.reduce((sum, line) => sum + line.costMinor, 0n),
      deposits,
      soldAt: options.when.at,
      dueDate: options.dueDate,
    });
    await tx
      .update(jobs)
      .set({ status: "done", saleId: bill.saleId, finishedAt: new Date(), finishedBy: tenant.userId, updatedAt: new Date() })
      .where(and(eq(jobs.tenantId, tenant.tenantId), eq(jobs.id, scope.job.id)));
    await this.record(tx, tenant, scope, "job.finished", { receipt: bill.number, invoice: bill.invoiceNumber, totalMinor: bill.total.toString(), balanceMinor: bill.balance.toString() });
  }

  // Helpers -------------------------------------------------------------------------------------------------------

  /** The day a record belongs to, in the business's time zone: today, or a past day up to 31 days back. */
  private when(business: BusinessRow, day?: string) {
    const today = localDate(new Date(), business.timezone);
    if (!day || day === today) return { day: today, at: new Date() };
    if (day > today) throw new ApiError("VALIDATION_ERROR", "That day has not come yet.", 400, [{ field: "day", message: "In the future." }]);
    if (daysBetween(day, today) > JOB_MAX_DAYS_BACK) {
      throw new ApiError("VALIDATION_ERROR", `Jobs can be recorded up to ${JOB_MAX_DAYS_BACK} days back.`, 400, [{ field: "day", message: "Too far back." }]);
    }
    return { day, at: zonedDateTime(day, "12:00:00", business.timezone) };
  }

  /** The customer chosen, or found by phone or exact name, or added with just a name (and phone). */
  private async customerFor(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, branch: BranchRow, payload: { customerId?: string | undefined; customer?: { name: string; phone?: string | undefined } | undefined }) {
    if (payload.customerId) return this.customer(tx, tenant, payload.customerId);
    const given = payload.customer as { name: string; phone?: string | undefined };
    let phone: string | null = null;
    if (given.phone) {
      const checked = checkPhone(given.phone, business.countryCode.trim());
      if (!checked?.ok) {
        const message = checked ? phoneProblemMessage(checked.problem, checked.country) : "Check the phone number.";
        throw new ApiError("VALIDATION_ERROR", message, 400, [{ field: "customer.phone", message }]);
      }
      phone = checked.e164;
      const [known] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), eq(customers.phoneE164, phone), isNull(customers.archivedAt)))
        .limit(1);
      if (known) return known;
    }
    const named = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), sql`lower(${customers.name}) = lower(${given.name})`, isNull(customers.archivedAt)))
      .limit(2);
    if (named.length === 1 && (!phone || !named[0]?.phoneE164)) {
      const match = named[0] as CustomerRow;
      if (phone && !match.phoneE164) {
        await tx.update(customers).set({ phoneE164: phone, isWalkIn: false, updatedAt: new Date(), updatedBy: tenant.userId }).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.id, match.id)));
      }
      return { ...match, phoneE164: phone ?? match.phoneE164 };
    }
    if (!tenant.permissions.includes(Permission.CUSTOMERS_ADD) && !tenant.permissions.includes(Permission.CUSTOMERS_MANAGE)) {
      throw new ApiError("FORBIDDEN", "Ask someone who can add customers to add this one first.", 403, [{ field: "customer", message: "Choose an existing customer." }]);
    }
    const [created] = await tx
      .insert(customers)
      .values({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, branchId: branch.id, name: given.name, phoneE164: phone, isWalkIn: phone === null, createdBy: tenant.userId, updatedBy: tenant.userId })
      .returning();
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "customer.created", entityType: "customer", entityId: (created as CustomerRow).id, correlationId: tenant.correlationId, businessId: business.id, branchId: branch.id, metadata: { from: "job" } },
      tx,
    );
    return created as CustomerRow;
  }

  /** A regular job, saved as a product that keeps no stock (found by name, or added). */
  private async saveRegular(tx: DbExecutor, tenant: TenantContext, businessId: string, name: string, price: bigint) {
    const [known] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), sql`lower(${products.name}) = lower(${name})`, eq(products.trackStock, false), isNull(products.archivedAt)))
      .limit(1);
    if (known) return known;
    const [created] = await tx
      .insert(products)
      .values({ id: newId(), tenantId: tenant.tenantId, businessId, name, baseUnit: "piece", priceMinor: price, trackStock: false, category: "Services", createdBy: tenant.userId, updatedBy: tenant.userId })
      .returning();
    return created as ProductRow;
  }

  /** A part bought for a job: the product of that name that keeps stock, or a new one counted in `unit`. */
  private async boughtProduct(tx: DbExecutor, tenant: TenantContext, businessId: string, name: string, unit: string) {
    const [known] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), sql`lower(${products.name}) = lower(${name})`, eq(products.trackStock, true), isNull(products.archivedAt)))
      .limit(1);
    if (known) return known;
    const [created] = await tx
      .insert(products)
      .values({ id: newId(), tenantId: tenant.tenantId, businessId, name, baseUnit: unit, trackStock: true, category: "Parts", createdBy: tenant.userId, updatedBy: tenant.userId })
      .returning();
    return created as ProductRow;
  }

  private async product(tx: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [product] = await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), eq(products.id, id), isNull(products.archivedAt))).limit(1);
    if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "A product on this job was not found.", 404);
    return product;
  }

  private async customer(tx: DbExecutor, tenant: TenantContext, id: string) {
    const business = await requireBusiness(tx, tenant);
    const [customer] = await tx.select().from(customers).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), eq(customers.id, id))).limit(1);
    if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404, [{ field: "customerId", message: "Not found." }]);
    return customer;
  }

  private async scope(tx: DbExecutor, tenant: TenantContext, id: string): Promise<Scope> {
    const business = await requireBusiness(tx, tenant);
    const job = await this.requireJob(tx, tenant, business.id, id, true);
    const branch = await resolveBranch(tx, tenant, business.id, job.branchId);
    if (branch.id !== job.branchId) throw new ApiError("NOT_FOUND", "Job not found.", 404);
    return { business, branch, job };
  }

  private async requireJob(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string, lock = false) {
    const filters = [eq(jobs.tenantId, tenant.tenantId), eq(jobs.businessId, businessId), eq(jobs.id, id)];
    const shop = tenant.membershipBranchId;
    if (shop) filters.push(eq(jobs.branchId, shop));
    const query = executor.select().from(jobs).where(and(...filters)).limit(1);
    const [job] = lock ? await query.for("update") : await query;
    if (!job) throw new ApiError("NOT_FOUND", "Job not found.", 404);
    return job;
  }

  private assertOpen(job: JobRow) {
    if (job.status === "done") throw new ApiError("JOB_DONE", "This job is finished and billed. Record a payment on it, or open a new job.", 409);
    if (job.status === "cancelled") throw new ApiError("JOB_CANCELLED", "This job was cancelled.", 409);
  }

  private assertCanTakeMoney(tenant: TenantContext) {
    if (!tenant.permissions.includes(Permission.PAYMENTS_RECORD) && !tenant.permissions.includes(Permission.SALES_COLLECT)) {
      throw new ApiError("FORBIDDEN", "Ask the cashier to take the money.", 403, [{ field: "payment", message: "The cashier takes money." }]);
    }
  }

  private async record(tx: DbExecutor, tenant: TenantContext, scope: Scope, action: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "job",
        entityId: scope.job.id,
        correlationId: tenant.correlationId,
        businessId: scope.business.id,
        branchId: scope.branch.id,
        actorType: tenant.actorType ?? "HUMAN",
        metadata: { number: scope.job.jobNumber, ...metadata },
      },
      tx,
    );
  }
}
