import { Inject, Injectable } from "@nestjs/common";
import { Permission } from "@bizora/contracts";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { DB } from "../../tokens.js";
import { findBranch, requireBusiness } from "../inventory/inventory-scope.js";

export const REPORT_PERIODS = ["week", "month", "year"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
const isDay = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
};

/** The first and last day of the week (Monday to Sunday), month or year holding `day`, and the period before. */
export function periodRange(period: ReportPeriod, day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (period === "week") {
    const monday = addDays(day, -((date.getUTCDay() + 6) % 7));
    return { from: monday, to: addDays(monday, 6), previous: { from: addDays(monday, -7), to: addDays(monday, -1) } };
  }
  const year = date.getUTCFullYear();
  if (period === "year") return { from: `${year}-01-01`, to: `${year}-12-31`, previous: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` } };
  const month = date.getUTCMonth();
  const first = iso(new Date(Date.UTC(year, month, 1)));
  const last = iso(new Date(Date.UTC(year, month + 1, 0)));
  return { from: first, to: last, previous: { from: iso(new Date(Date.UTC(year, month - 1, 1))), to: iso(new Date(Date.UTC(year, month, 0))) } };
}

type Money = { sales: bigint; discounts: bigint; returns: bigint };

/**
 * Sales for a week, month or year (ADR-058). Money comes from the books, the same as Money › Profit, so the two
 * always agree: sales (and service income), discounts and returns by the day they were booked. Counts, payment ways,
 * what is still owed, top items and the split by staff come from the sales themselves, by the business's own day.
 * Staff tied to one shop see that shop only; someone who may see only their own sales sees only those.
 */
@Injectable()
export class SalesReportService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async report(tenant: TenantContext, query: { period?: string; date?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const period = (REPORT_PERIODS as readonly string[]).includes(query.period ?? "") ? (query.period as ReportPeriod) : "month";
    const today = localDate(new Date(), business.timezone);
    const day = isDay(query.date) ? query.date : today;
    const range = periodRange(period, day);
    const shop = tenant.membershipBranchId ?? (query.branchId ? (await findBranch(this.db, tenant, business.id, query.branchId)).id : null);
    const ownOnly = !tenant.permissions.includes(Permission.SALES_READ_ALL);
    const seesSplits = !tenant.membershipBranchId && !ownOnly;
    const scope = { tenantId: tenant.tenantId, businessId: business.id, timezone: business.timezone, shop, membershipId: ownOnly ? tenant.membershipId : null };

    const [now, before, series, counts, payments, owed, top, byShop, byStaff] = await Promise.all([
      ownOnly ? this.salesMoney(scope, range.from, range.to) : this.booksMoney(scope, range.from, range.to),
      ownOnly ? this.salesMoney(scope, range.previous.from, range.previous.to) : this.booksMoney(scope, range.previous.from, range.previous.to),
      this.series(scope, range.from, range.to, period === "year" ? "month" : "day", ownOnly),
      this.counts(scope, range.from, range.to),
      this.payments(scope, range.from, range.to),
      this.owed(scope, range.from, range.to),
      this.topItems(scope, range.from, range.to),
      seesSplits ? this.byShop(scope, range.from, range.to) : Promise.resolve(null),
      seesSplits ? this.byStaff(scope, range.from, range.to) : Promise.resolve(null),
    ]);
    const net = (money: Money) => money.sales - money.discounts - money.returns;
    const netNow = net(now);
    const netBefore = net(before);
    return {
      period,
      from: range.from,
      to: range.to,
      previous: { from: range.previous.from, to: range.previous.to, netSalesMinor: netBefore.toString() },
      today,
      currency: business.baseCurrencyCode.trim(),
      shopId: shop,
      ownSalesOnly: ownOnly,
      salesMinor: now.sales.toString(),
      discountsMinor: now.discounts.toString(),
      returnsMinor: now.returns.toString(),
      netSalesMinor: netNow.toString(),
      /** Up or down on the period before, in hundredths of a percent; null when the period before had no sales. */
      changeBps: netBefore > 0n ? Number(((netNow - netBefore) * 10_000n) / netBefore) : null,
      salesCount: counts.count,
      averageSaleMinor: counts.count > 0 ? (netNow / BigInt(counts.count)).toString() : "0",
      payments,
      stillOwedMinor: owed.toString(),
      series,
      topItems: top,
      byShop,
      byStaff,
    };
  }

  /** The report as a spreadsheet: one row per day (or month), then the totals. */
  async csv(tenant: TenantContext, query: { period?: string; date?: string; branchId?: string }) {
    const report = await this.report(tenant, query);
    const money = (minor: string) => {
      const value = BigInt(minor);
      const sign = value < 0n ? "-" : "";
      const abs = value < 0n ? -value : value;
      return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
    };
    const rows = [["Period", `Sales (${report.currency})`, "Discounts", "Returns", "Net sales"]];
    for (const point of report.series) rows.push([point.label, money(point.salesMinor), money(point.discountsMinor), money(point.returnsMinor), money(point.netSalesMinor)]);
    rows.push([`${report.from} to ${report.to}`, money(report.salesMinor), money(report.discountsMinor), money(report.returnsMinor), money(report.netSalesMinor)]);
    rows.push([]);
    rows.push(["Number of sales", String(report.salesCount)]);
    rows.push(["Average sale", money(report.averageSaleMinor)]);
    rows.push(["Still owed from these sales", money(report.stillOwedMinor)]);
    for (const payment of report.payments) rows.push([`Paid by ${payment.method}`, money(payment.amountMinor)]);
    rows.push([]);
    rows.push(["Top items", "Unit", "Sold in", `Total (${report.currency})`]);
    for (const item of report.topItems) rows.push([item.name, item.unit, String(item.salesCount), money(item.totalMinor)]);
    // Formula-safe: a cell starting with = + - @ is read as text.
    const cell = (value: string) => {
      const safe = /^[=+\-@]/.test(value) && !/^-\d/.test(value) ? `'${value}` : value;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return {
      fileName: `bizora-sales-${report.period}-${report.from}.csv`,
      text: `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`,
    };
  }

  // The books ------------------------------------------------------------------------------------------------------

  private async booksMoney(scope: Scope, from: string, to: string): Promise<Money> {
    const [row] = rowsOf<{ sales: string; discounts: string; returns: string }>(
      await this.db.execute(sql`
        SELECT
          coalesce(sum(CASE WHEN a.role IN ('sales', 'service_income') THEN jl.credit_minor - jl.debit_minor ELSE 0 END), 0)::text AS sales,
          coalesce(sum(CASE WHEN a.role = 'discounts' THEN jl.debit_minor - jl.credit_minor ELSE 0 END), 0)::text AS discounts,
          coalesce(sum(CASE WHEN a.role = 'sales_returns' THEN jl.debit_minor - jl.credit_minor ELSE 0 END), 0)::text AS returns
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
        JOIN ledger_accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
        WHERE jl.tenant_id = ${scope.tenantId} AND je.business_id = ${scope.businessId}
          AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
          AND a.role IN ('sales', 'service_income', 'discounts', 'sales_returns')
          ${scope.shop ? sql`AND je.branch_id = ${scope.shop}` : sql``}`),
    );
    return { sales: BigInt(row?.sales ?? "0"), discounts: BigInt(row?.discounts ?? "0"), returns: BigInt(row?.returns ?? "0") };
  }

  /** Someone who sees only their own sales: totals from those sales (the books are not split by person). */
  private async salesMoney(scope: Scope, from: string, to: string): Promise<Money> {
    const [row] = rowsOf<{ sales: string; discounts: string }>(
      await this.db.execute(sql`
        SELECT coalesce(sum(s.subtotal_minor), 0)::text AS sales, coalesce(sum(s.discount_minor), 0)::text AS discounts
        FROM sales s WHERE ${this.salesWhere(scope, from, to)}`),
    );
    return { sales: BigInt(row?.sales ?? "0"), discounts: BigInt(row?.discounts ?? "0"), returns: 0n };
  }

  private async series(scope: Scope, from: string, to: string, by: "day" | "month", ownOnly: boolean) {
    const bucket = by === "month" ? sql`to_char(day, 'YYYY-MM')` : sql`to_char(day, 'YYYY-MM-DD')`;
    const rows = ownOnly
      ? rowsOf<{ label: string; sales: string; discounts: string; returns: string }>(
          await this.db.execute(sql`
            SELECT ${bucket} AS label, coalesce(sum(sales), 0)::text AS sales, coalesce(sum(discounts), 0)::text AS discounts, '0' AS returns
            FROM (SELECT (s.sold_at AT TIME ZONE ${scope.timezone})::date AS day, s.subtotal_minor AS sales, s.discount_minor AS discounts
                  FROM sales s WHERE ${this.salesWhere(scope, from, to)}) t
            GROUP BY 1 ORDER BY 1`),
        )
      : rowsOf<{ label: string; sales: string; discounts: string; returns: string }>(
          await this.db.execute(sql`
            SELECT ${bucket} AS label,
              coalesce(sum(CASE WHEN role IN ('sales', 'service_income') THEN credit - debit ELSE 0 END), 0)::text AS sales,
              coalesce(sum(CASE WHEN role = 'discounts' THEN debit - credit ELSE 0 END), 0)::text AS discounts,
              coalesce(sum(CASE WHEN role = 'sales_returns' THEN debit - credit ELSE 0 END), 0)::text AS returns
            FROM (SELECT je.entry_date AS day, a.role, jl.debit_minor AS debit, jl.credit_minor AS credit
                  FROM journal_lines jl
                  JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
                  JOIN ledger_accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
                  WHERE jl.tenant_id = ${scope.tenantId} AND je.business_id = ${scope.businessId}
                    AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
                    AND a.role IN ('sales', 'service_income', 'discounts', 'sales_returns')
                    ${scope.shop ? sql`AND je.branch_id = ${scope.shop}` : sql``}) t
            GROUP BY 1 ORDER BY 1`),
        );
    const found = new Map(rows.map((row) => [row.label, row]));
    // Every day (or month) of the period, with zero where nothing was sold, so a chart has no gaps.
    const labels: string[] = [];
    if (by === "month") {
      const year = Number(from.slice(0, 4));
      for (let month = 1; month <= 12; month += 1) labels.push(`${year}-${String(month).padStart(2, "0")}`);
    } else {
      for (let day = from; day <= to; day = addDays(day, 1)) labels.push(day);
    }
    return labels.map((label) => {
      const row = found.get(label);
      const sales = BigInt(row?.sales ?? "0");
      const discounts = BigInt(row?.discounts ?? "0");
      const returns = BigInt(row?.returns ?? "0");
      return { label, salesMinor: sales.toString(), discountsMinor: discounts.toString(), returnsMinor: returns.toString(), netSalesMinor: (sales - discounts - returns).toString() };
    });
  }

  // The sales themselves -------------------------------------------------------------------------------------------

  /** Sales that count: completed or waiting for the store, not cancelled, not history from before Bizora. */
  private salesWhere(scope: Scope, from: string, to: string) {
    return sql`s.tenant_id = ${scope.tenantId} AND s.business_id = ${scope.businessId}
      AND s.status IN ('completed', 'awaiting_release') AND s.voided_at IS NULL AND s.history_only = false
      AND (s.sold_at AT TIME ZONE ${scope.timezone})::date >= ${from}::date
      AND (s.sold_at AT TIME ZONE ${scope.timezone})::date <= ${to}::date
      ${scope.shop ? sql`AND s.branch_id = ${scope.shop}` : sql``}
      ${scope.membershipId ? sql`AND s.membership_id = ${scope.membershipId}` : sql``}`;
  }

  private async counts(scope: Scope, from: string, to: string) {
    const [row] = rowsOf<{ count: number }>(await this.db.execute(sql`SELECT count(*)::int AS count FROM sales s WHERE ${this.salesWhere(scope, from, to)}`));
    return { count: Number(row?.count ?? 0) };
  }

  private async payments(scope: Scope, from: string, to: string) {
    const rows = rowsOf<{ method: string; amount: string }>(
      await this.db.execute(sql`
        SELECT p.method, coalesce(sum(p.amount_minor), 0)::text AS amount
        FROM sale_payments p JOIN sales s ON s.tenant_id = p.tenant_id AND s.id = p.sale_id
        WHERE ${this.salesWhere(scope, from, to)}
        GROUP BY p.method ORDER BY sum(p.amount_minor) DESC`),
    );
    return rows.map((row) => ({ method: row.method, amountMinor: BigInt(row.amount).toString() }));
  }

  /** What these sales still owe today. */
  private async owed(scope: Scope, from: string, to: string) {
    const [row] = rowsOf<{ owed: string }>(await this.db.execute(sql`SELECT coalesce(sum(s.balance_minor), 0)::text AS owed FROM sales s WHERE ${this.salesWhere(scope, from, to)}`));
    return BigInt(row?.owed ?? "0");
  }

  private async topItems(scope: Scope, from: string, to: string) {
    const rows = rowsOf<{ name: string; unit: string; kind: string; count: number; quantity: string; total: string; cost_known: boolean }>(
      await this.db.execute(sql`
        SELECT sl.description AS name, sl.entered_unit AS unit, sl.line_kind AS kind, count(*)::int AS count,
          coalesce(sum(sl.entered_quantity), 0)::text AS quantity, coalesce(sum(sl.line_total_minor), 0)::text AS total,
          bool_and(sl.line_kind = 'service' OR sl.cost_minor IS NOT NULL) AS cost_known
        FROM sale_lines sl JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
        WHERE ${this.salesWhere(scope, from, to)} AND sl.line_kind <> 'amount'
        GROUP BY sl.description, sl.entered_unit, sl.line_kind
        ORDER BY sum(sl.line_total_minor) DESC
        LIMIT 20`),
    );
    return rows.map((row) => ({
      name: row.name,
      unit: row.unit,
      kind: row.kind,
      salesCount: Number(row.count),
      quantity: row.quantity,
      totalMinor: BigInt(row.total).toString(),
      costKnown: row.kind === "service" ? true : Boolean(row.cost_known),
    }));
  }

  private async byShop(scope: Scope, from: string, to: string) {
    const rows = rowsOf<{ id: string; name: string; net: string }>(
      await this.db.execute(sql`
        SELECT b.id, b.name, coalesce(sum(CASE WHEN a.role IN ('sales', 'service_income') THEN jl.credit_minor - jl.debit_minor
                                                WHEN a.role IN ('discounts', 'sales_returns') THEN jl.credit_minor - jl.debit_minor ELSE 0 END), 0)::text AS net
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
        JOIN ledger_accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
        JOIN branches b ON b.tenant_id = je.tenant_id AND b.id = je.branch_id
        WHERE jl.tenant_id = ${scope.tenantId} AND je.business_id = ${scope.businessId}
          AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
          AND a.role IN ('sales', 'service_income', 'discounts', 'sales_returns')
          ${scope.shop ? sql`AND je.branch_id = ${scope.shop}` : sql``}
        GROUP BY b.id, b.name ORDER BY 3 DESC`),
    );
    return rows.map((row) => ({ id: row.id, name: row.name, netSalesMinor: BigInt(row.net).toString() }));
  }

  /** Sales by the person who made them (before returns, which are booked later and not by person). */
  private async byStaff(scope: Scope, from: string, to: string) {
    const rows = rowsOf<{ id: string | null; name: string | null; count: number; total: string }>(
      await this.db.execute(sql`
        SELECT s.created_by AS id, u.display_name AS name, count(*)::int AS count, coalesce(sum(s.total_minor), 0)::text AS total
        FROM sales s LEFT JOIN users u ON u.id = s.created_by
        WHERE ${this.salesWhere(scope, from, to)}
        GROUP BY s.created_by, u.display_name ORDER BY sum(s.total_minor) DESC`),
    );
    return rows.map((row) => ({ id: row.id, name: row.name ?? "Unknown", salesCount: Number(row.count), totalMinor: BigInt(row.total).toString() }));
  }
}

type Scope = { tenantId: string; businessId: string; timezone: string; shop: string | null; membershipId: string | null };

export function assertPeriod(value: string | undefined) {
  if (value && !(REPORT_PERIODS as readonly string[]).includes(value)) throw new ApiError("VALIDATION_ERROR", "Choose week, month or year.", 400, [{ field: "period", message: "Week, month or year." }]);
}
