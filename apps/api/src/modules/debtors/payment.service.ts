import { customerPath, handleOf } from "../../common/handles.js";
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { customerPaymentSchema, Permission, paymentVoidSchema, whatsAppHref, type DebtorFilter } from "@bizora/contracts";
import { formatMoney } from "@bizora/money/format";
import { and, asc, desc, eq, gt, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { businesses, customerPayments, customers, paymentAllocations, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { requireBusiness, resolveBranch } from "../inventory/inventory-scope.js";
import { LedgerPostingService } from "../ledger/ledger-posting.service.js";
import { BrandingService } from "../branding/branding.service.js";
import { renderPdf, type DocumentModel } from "../sales/sale-document.js";

type SaleRow = typeof sales.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type PaymentRow = typeof customerPayments.$inferSelect;

const SEVEN_DAYS_MS = 7 * 86_400_000;
const OPEN = ["awaiting_release", "completed"];
const METHOD = { cash: "Cash", transfer: "Bank transfer", pos: "POS" } as Record<string, string>;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
export const DEBTOR_PAGE_SIZE = 25;

/**
 * Debtors and payments (ADR-019). What a customer owes is the balance left on their credit sales. A payment is
 * applied to those sales (oldest due first, or one chosen sale), lowering each sale's balance, and posts
 * Dr cash/bank/POS clearing, Cr debtors. Cancelling a payment puts the balances back and reverses the entry.
 */
@Injectable()
export class PaymentService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BrandingService) private readonly branding: BrandingService,
  ) {}

  async record(tenant: TenantContext, customerId: string, raw: unknown, options: { source?: "online" | "offline" } = {}) {
    const payload = customerPaymentSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(customerPayments).where(eq(customerPayments.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.present(tenant, taken);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const receivedAt = this.receivedAt(payload.receivedAt);
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      await this.recordIn(tx, tenant, customerId, { id, amount: BigInt(payload.amountMinor), method: payload.method, reference: payload.reference, note: payload.note, saleId: payload.saleId, receivedAt, source: options.source ?? "online" });
    });
    return this.get(tenant, id);
  }

  /**
   * Records a payment inside the caller's transaction. Used by the API above and by bank reconciliation (ADR-020),
   * which records transfers seen on a statement, possibly older than 7 days.
   */
  async recordIn(
    tx: DbExecutor,
    tenant: TenantContext,
    customerId: string,
    input: { id: string; amount: bigint; method: "cash" | "transfer" | "pos"; reference?: string | undefined; note?: string | undefined; saleId?: string | undefined; receivedAt: Date; source: string },
  ) {
    const payload = { saleId: input.saleId, method: input.method, reference: input.reference, note: input.note };
    const id = input.id;
    const receivedAt = input.receivedAt;
    {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id);
      const customer = await this.requireCustomer(tx, tenant, business.id, customerId);
      const open = await this.openSales(tx, tenant, business.id, customer.id, true);
      const targets = payload.saleId ? open.filter((sale) => sale.id === payload.saleId) : open;
      if (payload.saleId && targets.length === 0) throw new ApiError("NOT_OWING", "That sale has nothing left to pay.", 400, [{ field: "saleId", message: "Nothing owed." }]);
      const owing = targets.reduce((sum, sale) => sum + sale.balanceMinor, 0n);
      const amount = input.amount;
      if (owing === 0n) throw new ApiError("NOT_OWING", `${customer.name} does not owe anything.`, 400);
      if (amount > owing) {
        throw new ApiError("OVERPAID", `${customer.name} owes only ${formatMoney(owing, business.baseCurrencyCode.trim(), "en-NG")}${payload.saleId ? " on that sale" : ""}. Record that, and give change from the drawer.`, 400, [
          { field: "amountMinor", message: "More than owed." },
        ]);
      }
      // Oldest due first; sales without a due date after those with one, oldest sale first.
      let left = amount;
      const allocations: { sale: SaleRow; amount: bigint }[] = [];
      for (const sale of targets) {
        if (left === 0n) break;
        const applied = sale.balanceMinor < left ? sale.balanceMinor : left;
        allocations.push({ sale, amount: applied });
        left -= applied;
      }

      const number = await this.numbers.next(tx, tenant.tenantId, business.id, "payment");
      const methodAccount = { cash: { role: "cash" as const, branchId: branch.id }, transfer: { role: "bank" as const }, pos: { role: "pos_clearing" as const } }[payload.method];
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: localDate(receivedAt, business.timezone),
          source: { type: "payment", id },
          postingKey: `payment:${id}`,
          description: `Payment ${number.number} from ${customer.name}`,
          lines: [
            { account: methodAccount, debitMinor: amount, memo: payload.method },
            { account: { role: "debtors" }, creditMinor: amount, memo: customer.name },
          ],
        },
      );
      await tx.insert(customerPayments).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        customerId: customer.id,
        paymentNumber: number.number,
        method: payload.method,
        amountMinor: amount,
        currencyCode: business.baseCurrencyCode.trim(),
        reference: payload.reference ?? null,
        note: payload.note ?? null,
        receivedAt,
        journalEntryId: posted.entryId,
        receiptToken: randomBytes(24).toString("base64url"),
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
        actorType: tenant.actorType ?? "HUMAN",
      });
      for (const allocation of allocations) {
        await tx.insert(paymentAllocations).values({ id: newId(), tenantId: tenant.tenantId, paymentId: id, saleId: allocation.sale.id, amountMinor: allocation.amount });
        await tx
          .update(sales)
          .set({ paidMinor: sql`${sales.paidMinor} + ${allocation.amount}`, balanceMinor: sql`${sales.balanceMinor} - ${allocation.amount}` })
          .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, allocation.sale.id)));
      }
      await this.record_(tx, tenant, business.id, branch.id, "payment.recorded", id, {
        number: number.number,
        amountMinor: amount.toString(),
        method: payload.method,
        customerId: customer.id,
        sales: allocations.map((allocation) => allocation.sale.saleNumber ?? allocation.sale.invoiceNumber),
        source: input.source,
      });
    }
    return id;
  }

  /** A manager or owner cancels a payment recorded by mistake; the sales owe again what it paid. */
  async void(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = paymentVoidSchema.parse(raw);
    await this.db.transaction(async (tx) => this.voidIn(tx, tenant, id, reason));
    return this.get(tenant, id);
  }

  /** Cancels a payment inside the caller's transaction (also used when a bank match is undone). */
  async voidIn(tx: DbExecutor, tenant: TenantContext, id: string, reason: string) {
    {
      const payment = await this.requirePayment(tx, tenant, id, true);
      if (payment.status === "voided") throw new ApiError("ALREADY_VOIDED", "This payment has already been cancelled.", 409);
      const business = await requireBusiness(tx, tenant);
      if (payment.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, payment.journalEntryId, {
          entryDate: localDate(new Date(), business.timezone),
          reason: `Payment ${payment.paymentNumber} cancelled: ${reason}`,
        });
      }
      const allocations = await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.tenantId, tenant.tenantId), eq(paymentAllocations.paymentId, payment.id)));
      for (const allocation of allocations) {
        await tx
          .update(sales)
          .set({ paidMinor: sql`${sales.paidMinor} - ${allocation.amountMinor}`, balanceMinor: sql`${sales.balanceMinor} + ${allocation.amountMinor}` })
          .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, allocation.saleId)));
      }
      await tx
        .update(customerPayments)
        .set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason })
        .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.id, payment.id)));
      await this.record_(tx, tenant, payment.businessId, payment.branchId, "payment.voided", payment.id, { number: payment.paymentNumber, reason });
    }
  }

  /** Customers who owe, most overdue first. Shop staff see debts from their own shop. */
  async debtors(tenant: TenantContext, query: { filter?: DebtorFilter; q?: string; page?: number }) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const filters = this.openFilters(tenant, business.id);
    if (query.q?.trim()) filters.push(ilike(customers.name, `%${query.q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`));
    const overdue = sql<string>`coalesce(sum(CASE WHEN ${sales.dueDate} < ${today} THEN ${sales.balanceMinor} ELSE 0 END), 0)`;
    const owing = sql<string>`coalesce(sum(${sales.balanceMinor}), 0)`;
    const having = query.filter === "overdue" ? sql`${overdue} > 0` : sql`${owing} > 0`;
    const page = Math.max(1, query.page ?? 1);
    const grouped = this.db
      .select({
        customerId: customers.id,
        name: customers.name,
        phone: customers.phoneE164,
        owing,
        overdue,
        oldestDue: sql<string | null>`min(${sales.dueDate})`,
        sales: sql<number>`count(*)::int`,
      })
      .from(sales)
      .innerJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .where(and(...filters))
      .groupBy(customers.id, customers.name, customers.phoneE164)
      .having(having);
    const [rows, totals] = await Promise.all([
      grouped
        .orderBy(desc(overdue), sql`min(${sales.dueDate}) ASC NULLS LAST`, asc(customers.name))
        .limit(DEBTOR_PAGE_SIZE)
        .offset((page - 1) * DEBTOR_PAGE_SIZE),
      this.db
        .select({
          owing,
          overdue,
          debtors: sql<number>`count(DISTINCT ${sales.customerId})::int`,
          overdueDebtors: sql<number>`count(DISTINCT CASE WHEN ${sales.dueDate} < ${today} THEN ${sales.customerId} END)::int`,
        })
        .from(sales)
        .innerJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .where(and(...filters)),
    ]);
    const seeContact = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const total = totals[0];
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      totals: {
        owingMinor: BigInt(total?.owing ?? 0).toString(),
        overdueMinor: BigInt(total?.overdue ?? 0).toString(),
        debtors: Number(total?.debtors ?? 0),
        overdueDebtors: Number(total?.overdueDebtors ?? 0),
      },
      page,
      pageSize: DEBTOR_PAGE_SIZE,
      items: rows.map((row) => ({
        customerId: row.customerId,
        name: row.name,
        phoneLast4: row.phone ? row.phone.slice(-4) : null,
        ...(seeContact ? { phone: row.phone } : {}),
        owingMinor: BigInt(row.owing).toString(),
        overdueMinor: BigInt(row.overdue).toString(),
        oldestDueDate: row.oldestDue,
        openSales: Number(row.sales),
      })),
    };
  }

  /** One customer's account: what they owe on which sales, their payments, and a reminder ready for WhatsApp. */
  async account(tenant: TenantContext, customerId: string) {
    const business = await requireBusiness(this.db, tenant);
    const customer = await this.requireCustomer(this.db, tenant, business.id, customerId);
    const today = localDate(new Date(), business.timezone);
    const open = await this.openSales(this.db, tenant, business.id, customer.id, false);
    const paymentFilters: SQL[] = [eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.businessId, business.id), eq(customerPayments.customerId, customer.id)];
    if (tenant.membershipBranchId) paymentFilters.push(eq(customerPayments.branchId, tenant.membershipBranchId));
    const payments = await this.db
      .select({ payment: customerPayments, byName: users.displayName })
      .from(customerPayments)
      .leftJoin(users, eq(users.id, customerPayments.createdBy))
      .where(and(...paymentFilters))
      .orderBy(desc(customerPayments.receivedAt), desc(customerPayments.id))
      .limit(50);
    const token = customer.statementToken ?? (await this.newStatementToken(customer));
    const owing = open.reduce((sum, sale) => sum + sale.balanceMinor, 0n);
    const overdue = open.filter((sale) => sale.dueDate && sale.dueDate < today).reduce((sum, sale) => sum + sale.balanceMinor, 0n);
    const currency = business.baseCurrencyCode.trim();
    const money = (minor: bigint) => formatMoney(minor, currency, "en-NG");
    const seeContact = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    const text =
      owing > 0n
        ? `Hello ${customer.name}, this is ${business.name}. You owe ${money(owing)}${overdue > 0n ? `, of which ${money(overdue)} is overdue` : ""}. See your statement here: `
        : `Hello ${customer.name}, this is ${business.name}. Thank you, you owe nothing. Your statement: `;
    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phoneLast4: customer.phoneE164 ? customer.phoneE164.slice(-4) : null,
        // The full number only for people who may see customers in full (not the cashier's counter view).
        ...(seeContact ? { phone: customer.phoneE164 } : {}),
        credit: { allowed: customer.creditAllowed, limitMinor: customer.creditLimitMinor?.toString() ?? null },
      },
      currency,
      today,
      owingMinor: owing.toString(),
      overdueMinor: overdue.toString(),
      sales: open.map((sale) => ({
        id: sale.id,
        number: sale.saleNumber,
        invoiceNumber: sale.invoiceNumber,
        soldAt: sale.soldAt,
        dueDate: sale.dueDate,
        overdue: Boolean(sale.dueDate && sale.dueDate < today),
        totalMinor: sale.totalMinor.toString(),
        paidMinor: sale.paidMinor.toString(),
        balanceMinor: sale.balanceMinor.toString(),
      })),
      payments: payments.map(({ payment, byName }) => ({ ...this.summary(payment), byName })),
      statementPath: customerPath(await handleOf(this.db, customer.tenantId), "s", token),
      reminder: {
        text,
        phone: seeContact && customer.phoneE164 ? customer.phoneE164 : null,
        hrefPrefix: seeContact && customer.phoneE164 ? whatsAppHref(customer.phoneE164, "") : "https://wa.me/",
      },
    };
  }

  /** Total owed and overdue in this shop, for Home. */
  async totals(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const [row] = await this.db
      .select({
        owing: sql<string>`coalesce(sum(${sales.balanceMinor}), 0)`,
        overdue: sql<string>`coalesce(sum(CASE WHEN ${sales.dueDate} < ${today} THEN ${sales.balanceMinor} ELSE 0 END), 0)`,
        debtors: sql<number>`count(DISTINCT ${sales.customerId})::int`,
      })
      .from(sales)
      .where(and(...this.openFilters(tenant, business.id)));
    return { currency: business.baseCurrencyCode.trim(), owingMinor: BigInt(row?.owing ?? 0).toString(), overdueMinor: BigInt(row?.overdue ?? 0).toString(), debtors: Number(row?.debtors ?? 0) };
  }

  /** A new statement link; the old one stops working (for when a link went to the wrong person). */
  async rotateStatementLink(tenant: TenantContext, customerId: string) {
    const business = await requireBusiness(this.db, tenant);
    const customer = await this.requireCustomer(this.db, tenant, business.id, customerId);
    await this.newStatementToken(customer);
    await this.record_(this.db, tenant, business.id, null, "customer.statement_link_changed", customer.id, {});
    return this.account(tenant, customerId);
  }

  async get(tenant: TenantContext, id: string) {
    const payment = await this.requirePayment(this.db, tenant, id);
    return this.present(tenant, payment);
  }

  async document(tenant: TenantContext, id: string) {
    const payment = await this.requirePayment(this.db, tenant, id);
    return this.receiptPdf(payment);
  }

  /** What the customer's statement link shows: what is owed, on which sales, and recent payments. No phone or costs. */
  async publicStatement(token: string) {
    const statement = await this.statementByToken(token);
    return statement.view;
  }

  async publicLogo(token: string) {
    if (!TOKEN.test(token)) throw new ApiError("NOT_FOUND", "Statement not found.", 404);
    const [customer] = await this.db.select({ tenantId: customers.tenantId }).from(customers).where(eq(customers.statementToken, token)).limit(1);
    if (!customer) throw new ApiError("NOT_FOUND", "Statement not found.", 404);
    return this.branding.logoForTenant(customer.tenantId);
  }

  async publicStatementPdf(token: string) {
    const statement = await this.statementByToken(token);
    return statement.pdf();
  }

  // Helpers -----------------------------------------------------------------------------------------------------------

  private async statementByToken(token: string) {
    if (!TOKEN.test(token)) throw new ApiError("NOT_FOUND", "Statement not found.", 404);
    const [customer] = await this.db.select().from(customers).where(eq(customers.statementToken, token)).limit(1);
    if (!customer) throw new ApiError("NOT_FOUND", "Statement not found.", 404);
    const [business] = await this.db.select().from(businesses).where(and(eq(businesses.tenantId, customer.tenantId), eq(businesses.id, customer.businessId))).limit(1);
    if (!business) throw new ApiError("NOT_FOUND", "Statement not found.", 404);
    const today = localDate(new Date(), business.timezone);
    const open = await this.db
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, customer.tenantId), eq(sales.customerId, customer.id), gt(sales.balanceMinor, 0n), eq(sales.historyOnly, false), inArray(sales.status, OPEN)))
      .orderBy(sql`${sales.dueDate} ASC NULLS LAST`, asc(sales.soldAt));
    const payments = await this.db
      .select()
      .from(customerPayments)
      .where(and(eq(customerPayments.tenantId, customer.tenantId), eq(customerPayments.customerId, customer.id), eq(customerPayments.status, "recorded")))
      .orderBy(desc(customerPayments.receivedAt))
      .limit(10);
    const currency = business.baseCurrencyCode.trim();
    const owing = open.reduce((sum, sale) => sum + sale.balanceMinor, 0n);
    const overdue = open.filter((sale) => sale.dueDate && sale.dueDate < today).reduce((sum, sale) => sum + sale.balanceMinor, 0n);
    const brand = await this.branding.publicBrand(customer.tenantId, "invoice");
    const view = {
      businessName: business.name,
      shop: { phone: business.phoneE164 ?? null },
      // The owner's invoice message: usually how to pay them (bank details), shown on the statement page (6d).
      message: brand.message,
      hasLogo: brand.hasLogo,
      handle: brand.handle,
      color: brand.color,
      customerName: customer.name,
      currency,
      asOf: today,
      owingMinor: owing.toString(),
      overdueMinor: overdue.toString(),
      sales: open.map((sale) => ({
        number: sale.invoiceNumber ?? sale.saleNumber,
        soldAt: sale.soldAt,
        dueDate: sale.dueDate,
        overdue: Boolean(sale.dueDate && sale.dueDate < today),
        totalMinor: sale.totalMinor.toString(),
        balanceMinor: sale.balanceMinor.toString(),
      })),
      payments: payments.map((payment) => ({ number: payment.paymentNumber, receivedAt: payment.receivedAt, method: payment.method, amountMinor: payment.amountMinor.toString() })),
    };
    const money = (minor: bigint) => formatMoney(minor, currency, "en-NG");
    const day = (value: string) => formatDay(value);
    const pdf = async () => {
      const model: DocumentModel = {
        type: "invoice",
        title: "Statement",
        number: today,
        fileName: `Statement-${customer.name.replace(/[^A-Za-z0-9]+/g, "-")}-${today}.pdf`,
        shop: [business.name, business.phoneE164].filter((value): value is string => Boolean(value)),
        details: [
          ["Customer", customer.name],
          ["Statement date", day(today)],
        ],
        lines: open.map((sale) => ({
          description: `${sale.invoiceNumber ?? sale.saleNumber ?? ""} · ${day(localDate(sale.soldAt, business.timezone))}${sale.dueDate ? ` · due ${day(sale.dueDate)}${sale.dueDate < today ? " (overdue)" : ""}` : ""}`,
          quantity: "",
          price: money(sale.totalMinor),
          total: money(sale.balanceMinor),
        })),
        totals: [
          ["Total owing", money(owing), true],
          ...(overdue > 0n ? ([["Overdue", money(overdue)]] as [string, string][]) : []),
          ...payments.slice(0, 5).map((payment) => [`Paid ${day(localDate(payment.receivedAt, business.timezone))} (${payment.paymentNumber})`, money(payment.amountMinor)] as [string, string]),
        ],
        notices: owing > 0n ? [{ text: `Please pay ${money(owing)}${overdue > 0n ? `. ${money(overdue)} is overdue` : ""}.`, tone: overdue > 0n ? "danger" : "warning" }] : [{ text: "Nothing is owed. Thank you.", tone: "info" }],
      };
      return { fileName: model.fileName, pdf: await renderPdf(model, await this.branding.documentBrand(this.db, customer.tenantId, "statement")) };
    };
    return { view, pdf };
  }

  private async receiptPdf(payment: PaymentRow) {
    const [extra] = await this.db
      .select({ business: businesses, customerName: customers.name, byName: users.displayName })
      .from(customerPayments)
      .innerJoin(businesses, and(eq(businesses.tenantId, customerPayments.tenantId), eq(businesses.id, customerPayments.businessId)))
      .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
      .leftJoin(users, eq(users.id, customerPayments.createdBy))
      .where(and(eq(customerPayments.tenantId, payment.tenantId), eq(customerPayments.id, payment.id)))
      .limit(1);
    if (!extra) throw new ApiError("NOT_FOUND", "Payment not found.", 404);
    const allocations = await this.db
      .select({ amount: paymentAllocations.amountMinor, number: sql<string>`coalesce(${sales.invoiceNumber}, ${sales.saleNumber})`, balance: sales.balanceMinor })
      .from(paymentAllocations)
      .innerJoin(sales, and(eq(sales.tenantId, paymentAllocations.tenantId), eq(sales.id, paymentAllocations.saleId)))
      .where(and(eq(paymentAllocations.tenantId, payment.tenantId), eq(paymentAllocations.paymentId, payment.id)));
    const [owingRow] = await this.db
      .select({ owing: sql<string>`coalesce(sum(${sales.balanceMinor}), 0)` })
      .from(sales)
      .where(and(eq(sales.tenantId, payment.tenantId), eq(sales.customerId, payment.customerId), eq(sales.historyOnly, false), inArray(sales.status, OPEN)));
    const currency = payment.currencyCode.trim();
    const money = (minor: bigint) => formatMoney(minor, currency, "en-NG");
    const owing = BigInt(owingRow?.owing ?? 0);
    const model: DocumentModel = {
      type: "receipt",
      title: "Payment receipt",
      number: payment.paymentNumber,
      fileName: `Payment-receipt-${payment.paymentNumber}.pdf`,
      shop: [extra.business.name, extra.business.phoneE164].filter((value): value is string => Boolean(value)),
      details: [
        ["Receipt no.", payment.paymentNumber],
        ["Date", new Intl.DateTimeFormat("en-NG", { timeZone: extra.business.timezone, dateStyle: "medium", timeStyle: "short" }).format(payment.receivedAt)],
        ["Customer", extra.customerName],
        ["Paid by", METHOD[payment.method] ?? payment.method],
        ...(payment.reference ? ([["Reference", payment.reference]] as [string, string][]) : []),
        ...(extra.byName ? ([["Received by", extra.byName]] as [string, string][]) : []),
      ],
      lines: allocations.map((allocation) => ({ description: `Towards ${allocation.number}`, quantity: "", price: "", total: money(allocation.amount) })),
      totals: [
        ["Amount received", money(payment.amountMinor), true],
        ["Still owing", money(owing), true],
      ],
      notices:
        payment.status === "voided"
          ? [{ text: `CANCELLED${payment.voidReason ? `: ${payment.voidReason}` : ""}. This receipt is no longer valid.`, tone: "danger" }]
          : [{ text: owing > 0n ? `Thank you. ${money(owing)} is still owed.` : "Thank you. Nothing more is owed.", tone: owing > 0n ? "warning" : "info" }],
    };
    return { fileName: model.fileName, pdf: await renderPdf(model, await this.branding.documentBrand(this.db, payment.tenantId, "payment_receipt")) };
  }

  private async present(tenant: TenantContext, payment: PaymentRow) {
    const allocations = await this.db
      .select({ saleId: paymentAllocations.saleId, amount: paymentAllocations.amountMinor, number: sql<string>`coalesce(${sales.invoiceNumber}, ${sales.saleNumber})` })
      .from(paymentAllocations)
      .innerJoin(sales, and(eq(sales.tenantId, paymentAllocations.tenantId), eq(sales.id, paymentAllocations.saleId)))
      .where(and(eq(paymentAllocations.tenantId, tenant.tenantId), eq(paymentAllocations.paymentId, payment.id)));
    return { ...this.summary(payment), customerId: payment.customerId, allocations: allocations.map((row) => ({ saleId: row.saleId, number: row.number, amountMinor: row.amount.toString() })) };
  }

  private summary(payment: PaymentRow) {
    return {
      id: payment.id,
      number: payment.paymentNumber,
      method: payment.method,
      amountMinor: payment.amountMinor.toString(),
      currency: payment.currencyCode.trim(),
      reference: payment.reference,
      note: payment.note,
      receivedAt: payment.receivedAt,
      status: payment.status,
      voidReason: payment.voidReason,
    };
  }

  /** Credit sales with something left to pay: in this shop for shop staff, everywhere for others. */
  private openFilters(tenant: TenantContext, businessId: string): SQL[] {
    const filters: SQL[] = [
      eq(sales.tenantId, tenant.tenantId),
      eq(sales.businessId, businessId),
      gt(sales.balanceMinor, 0n),
      eq(sales.historyOnly, false),
      inArray(sales.status, OPEN),
    ];
    if (tenant.membershipBranchId) filters.push(eq(sales.branchId, tenant.membershipBranchId));
    return filters;
  }

  private async openSales(executor: DbExecutor, tenant: TenantContext, businessId: string, customerId: string, lock: boolean) {
    const query = executor
      .select()
      .from(sales)
      .where(and(...this.openFilters(tenant, businessId), eq(sales.customerId, customerId)))
      .orderBy(sql`${sales.dueDate} ASC NULLS LAST`, asc(sales.soldAt), asc(sales.id));
    return lock ? query.for("update") : query;
  }

  private async requireCustomer(executor: DbExecutor, tenant: TenantContext, businessId: string, customerId: string): Promise<CustomerRow> {
    const [customer] = await executor
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, businessId), eq(customers.id, customerId)))
      .limit(1);
    if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404);
    return customer;
  }

  private async requirePayment(executor: DbExecutor, tenant: TenantContext, id: string, lock = false): Promise<PaymentRow> {
    const filters: SQL[] = [eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.id, id)];
    if (tenant.membershipBranchId) filters.push(eq(customerPayments.branchId, tenant.membershipBranchId));
    const query = executor.select().from(customerPayments).where(and(...filters)).limit(1);
    const [payment] = lock ? await query.for("update") : await query;
    if (!payment) throw new ApiError("NOT_FOUND", "Payment not found.", 404);
    return payment;
  }

  private async newStatementToken(customer: CustomerRow) {
    const token = randomBytes(24).toString("base64url");
    await this.db.update(customers).set({ statementToken: token }).where(and(eq(customers.tenantId, customer.tenantId), eq(customers.id, customer.id)));
    return token;
  }

  private receivedAt(value: string | undefined) {
    if (!value) return new Date();
    const date = new Date(value);
    const now = Date.now();
    if (date.getTime() > now + 5 * 60_000) throw new ApiError("VALIDATION_ERROR", "The payment time is in the future. Check the phone's clock.", 400, [{ field: "receivedAt", message: "In the future." }]);
    if (date.getTime() < now - SEVEN_DAYS_MS) throw new ApiError("TOO_OLD", "Payments older than 7 days need a manager to record them.", 400, [{ field: "receivedAt", message: "Too old." }]);
    return date;
  }

  private async record_(executor: DbExecutor, tenant: TenantContext, businessId: string, branchId: string | null, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: action.startsWith("customer.") ? "customer" : "payment",
        entityId,
        correlationId: tenant.correlationId,
        businessId,
        ...(branchId ? { branchId } : {}),
        actorType: tenant.actorType ?? "HUMAN",
        metadata,
      },
      executor,
    );
  }
}

function formatDay(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-NG", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)));
}
