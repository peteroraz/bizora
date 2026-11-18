import { Inject, Injectable } from "@nestjs/common";
import { PROFIT_MAX_DAYS } from "@bizora/contracts";
import { aliasedTable, and, desc, eq, gt, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { customerPayments, customers, salePayments, saleReturns, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { requireBusiness } from "../inventory/inventory-scope.js";

const LIST_LIMIT = 200;
const DAY_MS = 86_400_000;
const isDay = (value: string | undefined): value is string =>
  Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

type Person = {
  name: string;
  discountsMinor: bigint;
  discountCount: number;
  cancelledMinor: bigint;
  cancelledCount: number;
  returnsMinor: bigint;
  returnsCount: number;
  lostMinor: bigint;
  lostCount: number;
};

/**
 * Discounts and cancellations (ADR-031): where money leaves the business at the counter. For a day or a month:
 * discounts and lowered prices, cancelled sales, goods taken back, cancelled payments and transfers that never came,
 * each with who did it, and totals per person.
 */
@Injectable()
export class DiscountsReportService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async report(tenant: TenantContext, query: { from?: string; to?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const tz = business.timezone;
    const today = localDate(new Date(), tz);
    const to = isDay(query.to) ? query.to : today;
    const from = isDay(query.from) ? query.from : to;
    if (from > to) throw new ApiError("VALIDATION_ERROR", "The first day must come before the last.", 400);
    if (Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1 > PROFIT_MAX_DAYS) {
      throw new ApiError("VALIDATION_ERROR", `Choose at most ${PROFIT_MAX_DAYS} days.`, 400);
    }
    const shop = tenant.membershipBranchId ?? query.branchId ?? null;
    const within = (column: SQL | typeof sales.soldAt) => sql`(timezone(${tz}, ${column}))::date BETWEEN ${from}::date AND ${to}::date`;

    const seller = aliasedTable(users, "seller");
    const canceller = aliasedTable(users, "canceller");
    const lineReductions = sql<string>`(SELECT coalesce(sum(l.discount_minor), 0) FROM sale_lines l WHERE l.tenant_id = ${sales.tenantId} AND l.sale_id = ${sales.id})`;

    const [discounted, cancelled, returned, cancelledPayments, lostSaleTransfers, lostPaymentTransfers] = await Promise.all([
      // Discounts off the total and prices lowered at the counter, on sales that still stand.
      this.db
        .select({
          id: sales.id,
          number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
          at: sales.soldAt,
          totalMinor: sales.totalMinor,
          discountMinor: sales.discountMinor,
          loweredMinor: lineReductions,
          customerName: customers.name,
          byId: sales.createdBy,
          byName: seller.displayName,
        })
        .from(sales)
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(seller, eq(seller.id, sales.createdBy))
        .where(
          and(
            eq(sales.tenantId, tenant.tenantId),
            eq(sales.businessId, business.id),
            ne(sales.status, "voided"),
            eq(sales.historyOnly, false),
            ...(shop ? [eq(sales.branchId, shop)] : []),
            within(sales.soldAt),
            or(gt(sales.discountMinor, 0n), sql`${lineReductions} > 0`),
          ),
        )
        .orderBy(desc(sales.soldAt))
        .limit(LIST_LIMIT),
      // Sales cancelled in the period, whenever they were made.
      this.db
        .select({
          id: sales.id,
          number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
          at: sales.voidedAt,
          soldAt: sales.soldAt,
          totalMinor: sales.totalMinor,
          stage: sql<string>`CASE WHEN ${sales.collectedAt} IS NULL AND ${sales.saleNumber} IS NULL THEN 'unpaid' ELSE 'paid' END`,
          reason: sales.voidReason,
          customerName: customers.name,
          soldByName: seller.displayName,
          byId: sales.voidedBy,
          byName: canceller.displayName,
        })
        .from(sales)
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(seller, eq(seller.id, sales.createdBy))
        .leftJoin(canceller, eq(canceller.id, sales.voidedBy))
        .where(
          and(
            eq(sales.tenantId, tenant.tenantId),
            eq(sales.businessId, business.id),
            eq(sales.status, "voided"),
            isNotNull(sales.voidedAt),
            ...(shop ? [eq(sales.branchId, shop)] : []),
            within(sql`${sales.voidedAt}`),
          ),
        )
        .orderBy(desc(sales.voidedAt))
        .limit(LIST_LIMIT),
      // Goods taken back (ADR-030).
      this.db
        .select({
          id: saleReturns.id,
          number: saleReturns.returnNumber,
          saleId: saleReturns.saleId,
          saleNumber: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
          at: saleReturns.createdAt,
          totalMinor: saleReturns.totalMinor,
          reason: saleReturns.reason,
          customerName: customers.name,
          byId: saleReturns.createdBy,
          byName: canceller.displayName,
        })
        .from(saleReturns)
        .innerJoin(sales, and(eq(sales.tenantId, saleReturns.tenantId), eq(sales.id, saleReturns.saleId)))
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(canceller, eq(canceller.id, saleReturns.createdBy))
        .where(and(eq(saleReturns.tenantId, tenant.tenantId), eq(saleReturns.businessId, business.id), ...(shop ? [eq(saleReturns.branchId, shop)] : []), within(sql`${saleReturns.createdAt}`)))
        .orderBy(desc(saleReturns.createdAt))
        .limit(LIST_LIMIT),
      // Payments from customers who owe, cancelled by hand (not those whose transfer never came: listed below).
      this.db
        .select({
          id: customerPayments.id,
          number: customerPayments.paymentNumber,
          at: customerPayments.voidedAt,
          amountMinor: customerPayments.amountMinor,
          method: customerPayments.method,
          reason: customerPayments.voidReason,
          customerName: customers.name,
          byId: customerPayments.voidedBy,
          byName: canceller.displayName,
        })
        .from(customerPayments)
        .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
        .leftJoin(canceller, eq(canceller.id, customerPayments.voidedBy))
        .where(
          and(
            eq(customerPayments.tenantId, tenant.tenantId),
            eq(customerPayments.businessId, business.id),
            eq(customerPayments.status, "voided"),
            ne(customerPayments.confirmation, "not_received"),
            isNotNull(customerPayments.voidedAt),
            ...(shop ? [eq(customerPayments.branchId, shop)] : []),
            within(sql`${customerPayments.voidedAt}`),
          ),
        )
        .orderBy(desc(customerPayments.voidedAt))
        .limit(LIST_LIMIT),
      // Transfers that never came (ADR-031), shown against the person who took them.
      this.db
        .select({
          id: salePayments.id,
          number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
          saleId: sales.id,
          at: salePayments.confirmedAt,
          amountMinor: salePayments.amountMinor,
          settle: salePayments.notReceivedAs,
          reason: salePayments.confirmationNote,
          customerName: customers.name,
          byId: sql<string | null>`coalesce(${sales.collectedBy}, ${sales.createdBy})`,
          byName: seller.displayName,
        })
        .from(salePayments)
        .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .leftJoin(seller, eq(seller.id, sql`coalesce(${sales.collectedBy}, ${sales.createdBy})`))
        .where(
          and(
            eq(salePayments.tenantId, tenant.tenantId),
            eq(salePayments.businessId, business.id),
            eq(salePayments.confirmation, "not_received"),
            ...(shop ? [eq(sales.branchId, shop)] : []),
            within(sql`${salePayments.confirmedAt}`),
          ),
        )
        .orderBy(desc(salePayments.confirmedAt))
        .limit(LIST_LIMIT),
      this.db
        .select({
          id: customerPayments.id,
          number: customerPayments.paymentNumber,
          at: customerPayments.confirmedAt,
          amountMinor: customerPayments.amountMinor,
          reason: customerPayments.confirmationNote,
          customerName: customers.name,
          byId: customerPayments.createdBy,
          byName: seller.displayName,
        })
        .from(customerPayments)
        .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
        .leftJoin(seller, eq(seller.id, customerPayments.createdBy))
        .where(
          and(
            eq(customerPayments.tenantId, tenant.tenantId),
            eq(customerPayments.businessId, business.id),
            eq(customerPayments.confirmation, "not_received"),
            ...(shop ? [eq(customerPayments.branchId, shop)] : []),
            within(sql`${customerPayments.confirmedAt}`),
          ),
        )
        .orderBy(desc(customerPayments.confirmedAt))
        .limit(LIST_LIMIT),
    ]);

    const people = new Map<string, Person>();
    const person = (id: string | null, name: string | null) => {
      const key = id ?? "unknown";
      const found = people.get(key);
      if (found) return found;
      const fresh: Person = { name: name ?? "", discountsMinor: 0n, discountCount: 0, cancelledMinor: 0n, cancelledCount: 0, returnsMinor: 0n, returnsCount: 0, lostMinor: 0n, lostCount: 0 };
      people.set(key, fresh);
      return fresh;
    };
    const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

    const discounts = discounted.map((row) => {
      const given = row.discountMinor + BigInt(row.loweredMinor);
      const who = person(row.byId, row.byName);
      who.discountsMinor += given;
      who.discountCount += 1;
      return {
        saleId: row.id,
        number: row.number,
        at: iso(row.at),
        totalMinor: row.totalMinor.toString(),
        discountMinor: row.discountMinor.toString(),
        loweredMinor: BigInt(row.loweredMinor).toString(),
        givenMinor: given.toString(),
        customerName: row.customerName,
        byName: row.byName,
      };
    });
    const cancellations = cancelled.map((row) => {
      const who = person(row.byId, row.byName);
      who.cancelledMinor += row.totalMinor;
      who.cancelledCount += 1;
      return {
        saleId: row.id,
        number: row.number,
        at: iso(row.at),
        soldAt: iso(row.soldAt),
        totalMinor: row.totalMinor.toString(),
        paid: row.stage === "paid",
        reason: row.reason,
        customerName: row.customerName,
        soldByName: row.soldByName,
        byName: row.byName,
      };
    });
    const returns = returned.map((row) => {
      const who = person(row.byId, row.byName);
      who.returnsMinor += row.totalMinor;
      who.returnsCount += 1;
      return {
        id: row.id,
        number: row.number,
        saleId: row.saleId,
        saleNumber: row.saleNumber,
        at: iso(row.at),
        totalMinor: row.totalMinor.toString(),
        reason: row.reason,
        customerName: row.customerName,
        byName: row.byName,
      };
    });
    const paymentsCancelled = cancelledPayments.map((row) => {
      const who = person(row.byId, row.byName);
      who.cancelledMinor += row.amountMinor;
      who.cancelledCount += 1;
      return {
        id: row.id,
        number: row.number,
        at: iso(row.at),
        amountMinor: row.amountMinor.toString(),
        method: row.method,
        reason: row.reason,
        customerName: row.customerName,
        byName: row.byName,
      };
    });
    const transfersNotReceived = [
      ...lostSaleTransfers.map((row) => ({ kind: "sale_payment" as const, id: row.id, number: row.number, saleId: row.saleId, at: iso(row.at), amountMinor: row.amountMinor, settle: row.settle ?? "lost", reason: row.reason, customerName: row.customerName, byId: row.byId, byName: row.byName })),
      ...lostPaymentTransfers.map((row) => ({ kind: "customer_payment" as const, id: row.id, number: row.number, saleId: null, at: iso(row.at), amountMinor: row.amountMinor, settle: "owed", reason: row.reason, customerName: row.customerName, byId: row.byId, byName: row.byName })),
    ]
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .map(({ byId, amountMinor, ...row }) => {
        const who = person(byId, row.byName);
        who.lostMinor += amountMinor;
        who.lostCount += 1;
        return { ...row, amountMinor: amountMinor.toString() };
      });

    const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n).toString();
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      from,
      to,
      branchId: shop,
      totals: {
        discountsMinor: sum(discounts.map((row) => BigInt(row.givenMinor))),
        cancelledSalesMinor: sum(cancellations.map((row) => BigInt(row.totalMinor))),
        returnsMinor: sum(returns.map((row) => BigInt(row.totalMinor))),
        paymentsCancelledMinor: sum(paymentsCancelled.map((row) => BigInt(row.amountMinor))),
        transfersNotReceivedMinor: sum(transfersNotReceived.map((row) => BigInt(row.amountMinor))),
      },
      people: [...people.values()]
        .map((row) => ({
          name: row.name,
          discountsMinor: row.discountsMinor.toString(),
          discountCount: row.discountCount,
          cancelledMinor: row.cancelledMinor.toString(),
          cancelledCount: row.cancelledCount,
          returnsMinor: row.returnsMinor.toString(),
          returnsCount: row.returnsCount,
          lostMinor: row.lostMinor.toString(),
          lostCount: row.lostCount,
        }))
        .sort((a, b) => b.discountCount + b.cancelledCount + b.returnsCount + b.lostCount - (a.discountCount + a.cancelledCount + a.returnsCount + a.lostCount)),
      discounts,
      cancellations,
      returns,
      paymentsCancelled,
      transfersNotReceived,
    };
  }
}
