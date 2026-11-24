import { Inject, Injectable } from "@nestjs/common";
import {
  CASH_FLOW_KINDS,
  cashCountSchema,
  expenseSchema,
  moneyMovementSchema,
  moneyReasonSchema,
  Permission,
  PROFIT_DAILY_MAX_DAYS,
  PROFIT_MAX_DAYS,
  type CashFlowKind,
  type ExpensePaidFrom,
  type ExpenseStatus,
  type MoneyMovementKind,
  posCashoutSchema,
} from "@bizora/contracts";
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import {
  branches,
  businesses,
  cashCounts,
  expenses,
  journalEntries,
  journalLines,
  ledgerAccounts,
  moneyMovements,
  saleLines,
  sales,
  users,
} from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness, resolveBranch } from "../inventory/inventory-scope.js";
import { ChartOfAccountsService } from "../ledger/chart-of-accounts.service.js";
import { LedgerPostingService, type AccountRef } from "../ledger/ledger-posting.service.js";

type Business = typeof businesses.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;

/** Expense accounts a trader can pick as "what was it for". Cost of goods, losses and fx are posted by the system. */
const CATEGORY_ROLES = ["expense", "bank_charges", "materials"];
/** Expense-type accounts that are the cost of what was sold, not running costs. */
const COST_OF_SALES_ROLES = new Set(["cogs", "materials"]);
const SALES_ROLES = new Set(["sales", "service_income"]);

const MOVEMENT_FLOW: Record<MoneyMovementKind, CashFlowKind> = {
  owner_in: "owner",
  owner_out: "owner",
  to_bank: "bank",
  from_bank: "bank",
  other_in: "other_in",
  pos_cashout: "pos_cashout",
};
const SOURCE_FLOW: Record<string, CashFlowKind> = {
  sale: "sales",
  payment: "debt_payments",
  expense: "expenses",
  stock_movement: "stock_bought",
  supplier_payment: "suppliers",
  sale_return: "refunds",
  cash_count: "counts",
  job_deposit: "deposits",
  job_cost: "job_costs",
};

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const isDay = (value: string | undefined): value is string =>
  Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

/**
 * Money in and out (ADR-028). Expenses, the owner's money, cash moved to and from the bank and cash counts each
 * post a balanced entry in the same transaction as their record (ADR-013). The cash expected in a drawer and the
 * profit are read straight from the ledger, so they always agree with the books.
 */
@Injectable()
export class MoneyService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(ChartOfAccountsService) private readonly chart: ChartOfAccountsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------- expenses */

  /** What money can be spent on: the business's expense accounts (rent, transport, fuel…), in code order. */
  async categories(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    await this.db.transaction((tx) => this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId));
    const rows = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenant.tenantId),
          eq(ledgerAccounts.businessId, business.id),
          eq(ledgerAccounts.accountType, "expense"),
          inArray(ledgerAccounts.role, CATEGORY_ROLES),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .orderBy(asc(ledgerAccounts.code));
    return { currency: business.baseCurrencyCode.trim(), categories: rows };
  }

  /**
   * Records an expense and posts Dr the category, Cr where the money came from: the shop's drawer, the bank, or
   * the owner's own pocket (money put in). Someone who may approve expenses records it approved; anyone else's
   * waits for the owner, who approves it or rejects it (rejecting reverses the entry).
   */
  async recordExpense(tenant: TenantContext, raw: unknown) {
    const payload = expenseSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(expenses).where(eq(expenses.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.presentExpense(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      const date = this.pastDay(payload.expenseDate, business, "expenseDate");
      await this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId);
      const [category] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.tenantId, tenant.tenantId),
            eq(ledgerAccounts.businessId, business.id),
            eq(ledgerAccounts.id, payload.categoryId),
            eq(ledgerAccounts.accountType, "expense"),
            inArray(ledgerAccounts.role, CATEGORY_ROLES),
            isNull(ledgerAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!category) {
        throw new ApiError("VALIDATION_ERROR", "Choose what the money was spent on.", 400, [{ field: "categoryId", message: "Choose a category." }]);
      }
      const amount = BigInt(payload.amountMinor);
      const approver = tenant.permissions.includes(Permission.EXPENSES_APPROVE);
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: date,
          source: { type: "expense", id },
          postingKey: `expense:${id}`,
          description: `${category.name}${payload.payee ? `: ${payload.payee}` : ""}`.slice(0, 240),
          lines: [
            { account: { id: category.id }, debitMinor: amount, ...(payload.note ? { memo: payload.note.slice(0, 240) } : {}) },
            { account: this.paidFromAccount(payload.paidFrom, branch.id), creditMinor: amount, memo: payload.paidFrom },
          ],
        },
      );
      await tx.insert(expenses).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        accountId: category.id,
        amountMinor: amount,
        currencyCode: business.baseCurrencyCode,
        paidFrom: payload.paidFrom,
        expenseDate: date,
        payee: payload.payee || null,
        note: payload.note || null,
        status: approver ? "approved" : "awaiting_approval",
        journalEntryId: posted.entryId,
        ...(approver ? { approvedAt: new Date(), approvedBy: tenant.userId } : {}),
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
      });
      await this.record(tx, tenant, business.id, branch.id, "expense.recorded", "expense", id, {
        category: category.name,
        amountMinor: amount.toString(),
        paidFrom: payload.paidFrom,
        date,
        status: approver ? "approved" : "awaiting_approval",
      });
    });
    return this.presentExpense(tenant, id);
  }

  async approveExpense(tenant: TenantContext, id: string) {
    await this.db.transaction(async (tx) => {
      const expense = await this.requireExpense(tx, tenant, id, true);
      if (expense.status !== "awaiting_approval") {
        throw new ApiError("NOT_WAITING", expense.status === "voided" ? "This expense was rejected." : "This expense is already approved.", 409);
      }
      await tx
        .update(expenses)
        .set({ status: "approved", approvedAt: new Date(), approvedBy: tenant.userId })
        .where(and(eq(expenses.tenantId, tenant.tenantId), eq(expenses.id, id)));
      await this.record(tx, tenant, expense.businessId, expense.branchId, "expense.approved", "expense", id, {});
    });
    return this.presentExpense(tenant, id);
  }

  /**
   * Rejects or cancels an expense: the entry is reversed and the record kept, marked voided, with the reason. The
   * owner (expenses.approve) can do this to any expense; whoever recorded one can cancel it while it still waits.
   */
  async voidExpense(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = moneyReasonSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const expense = await this.requireExpense(tx, tenant, id, true);
      if (expense.status === "voided") throw new ApiError("ALREADY_VOIDED", "This expense has already been cancelled.", 409);
      const approver = tenant.permissions.includes(Permission.EXPENSES_APPROVE);
      const ownWaiting = expense.createdBy === tenant.userId && expense.status === "awaiting_approval";
      if (!approver && !ownWaiting) {
        throw new ApiError("FORBIDDEN", "Only the owner can cancel an approved expense, or one someone else recorded.", 403);
      }
      const business = await requireBusiness(tx, tenant);
      if (expense.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, expense.journalEntryId, {
          entryDate: localDate(new Date(), business.timezone),
          reason: `Expense cancelled: ${reason}`,
        });
      }
      await tx
        .update(expenses)
        .set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason })
        .where(and(eq(expenses.tenantId, tenant.tenantId), eq(expenses.id, id)));
      await this.record(tx, tenant, expense.businessId, expense.branchId, "expense.voided", "expense", id, { reason, was: expense.status });
    });
    return this.presentExpense(tenant, id);
  }

  /** Expenses between two days (or waiting for approval), newest first, with totals by category. */
  async listExpenses(tenant: TenantContext, query: { from?: string; to?: string; status?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const waiting = query.status === "awaiting_approval";
    const to = isDay(query.to) ? query.to : today;
    const from = isDay(query.from) ? query.from : addDays(to, -30);
    if (!waiting) this.assertRange(from, to, PROFIT_MAX_DAYS);
    const filters: SQL[] = [eq(expenses.tenantId, tenant.tenantId), eq(expenses.businessId, business.id)];
    if (tenant.membershipBranchId) filters.push(eq(expenses.branchId, tenant.membershipBranchId));
    if (waiting) filters.push(eq(expenses.status, "awaiting_approval"));
    else filters.push(gte(expenses.expenseDate, from), lte(expenses.expenseDate, to));
    const rows = await this.expenseRows(and(...filters) as SQL, 300);
    const totals = new Map<string, { categoryId: string; name: string; amountMinor: bigint }>();
    let total = 0n;
    let awaiting = 0;
    for (const row of rows) {
      if (row.status === "voided") continue;
      if (row.status === "awaiting_approval") awaiting += 1;
      total += BigInt(row.amountMinor);
      const entry = totals.get(row.categoryId) ?? { categoryId: row.categoryId, name: row.category, amountMinor: 0n };
      entry.amountMinor += BigInt(row.amountMinor);
      totals.set(row.categoryId, entry);
    }
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      from: waiting ? null : from,
      to: waiting ? null : to,
      totalMinor: total.toString(),
      awaiting,
      byCategory: [...totals.values()]
        .sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0))
        .map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
      items: rows.map((row) => this.expenseView(tenant, row)),
    };
  }

  /** How many expenses wait for the owner (Home's approval card). */
  async waitingCount(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)::text` })
      .from(expenses)
      .where(and(eq(expenses.tenantId, tenant.tenantId), eq(expenses.businessId, business.id), eq(expenses.status, "awaiting_approval")));
    return { currency: business.baseCurrencyCode.trim(), count: row?.count ?? 0, amountMinor: row?.amount ?? "0" };
  }

  /* ------------------------------------------------------- money in and out */

  /**
   * The owner's money and moves between a drawer and the bank:
   * owner_in Dr cash Cr owner's money put in · owner_out Dr owner's withdrawals Cr cash ·
   * to_bank Dr bank Cr cash · from_bank Dr cash Cr bank · other_in Dr cash Cr other money in.
   */
  async recordMovement(tenant: TenantContext, raw: unknown) {
    const payload = moneyMovementSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(moneyMovements).where(eq(moneyMovements.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.movementView(taken);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      const date = this.pastDay(payload.movementDate, business, "movementDate");
      const amount = BigInt(payload.amountMinor);
      const cash: AccountRef = { role: "cash", branchId: branch.id };
      const [debit, credit, description]: [AccountRef, AccountRef, string] = {
        owner_in: [cash, { role: "capital" }, "Owner put money in"],
        owner_out: [{ role: "drawings" }, cash, "Owner took money out"],
        to_bank: [{ role: "bank" }, cash, "Cash paid into the bank"],
        from_bank: [cash, { role: "bank" }, "Cash drawn from the bank"],
        // Not a sale, so not profit (ADR-038).
        other_in: [cash, { role: "not_sales_money" }, "Other money in"],
      }[payload.kind] as [AccountRef, AccountRef, string];
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: date,
          source: { type: "money_movement", id },
          postingKey: `money:${id}`,
          description: `${description}${payload.note ? `: ${payload.note}` : ""}`.slice(0, 240),
          lines: [
            { account: debit, debitMinor: amount },
            { account: credit, creditMinor: amount },
          ],
        },
      );
      await tx.insert(moneyMovements).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        kind: payload.kind,
        amountMinor: amount,
        currencyCode: business.baseCurrencyCode,
        movementDate: date,
        note: payload.note || null,
        journalEntryId: posted.entryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
      });
      await this.record(tx, tenant, business.id, branch.id, "money.moved", "money_movement", id, { kind: payload.kind, amountMinor: amount.toString(), date });
    });
    const [row] = await this.db.select().from(moneyMovements).where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.id, id)));
    return this.movementView(row as typeof moneyMovements.$inferSelect);
  }

  /**
   * A POS cash-out (ADR-038). The customer pays on the shop's POS machine; the money waits with other POS payments
   * (1150) until the bank statement shows it. The drawer gives out the cash. The fee is profit:
   * fee on the POS: Dr 1150 cash + fee, Cr cash, Cr fees · fee in cash: Dr 1150 cash, Cr cash less the fee, Cr fees.
   */
  async recordPosCashout(tenant: TenantContext, raw: unknown) {
    const payload = posCashoutSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(moneyMovements).where(eq(moneyMovements.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.movementView(taken);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      const date = this.pastDay(payload.movementDate, business, "movementDate");
      const amount = BigInt(payload.amountMinor);
      const fee = BigInt(payload.feeMinor);
      const cash: AccountRef = { role: "cash", branchId: branch.id };
      const onPos = payload.feePaidBy === "pos";
      const lines = [
        { account: { role: "pos_clearing" } as AccountRef, debitMinor: onPos ? amount + fee : amount, memo: "Paid on the POS" },
        ...(onPos ? [{ account: cash, creditMinor: amount, memo: "Cash given" }] : amount - fee > 0n ? [{ account: cash, creditMinor: amount - fee, memo: "Cash given less the fee paid in cash" }] : []),
        ...(fee > 0n ? [{ account: { role: "pos_cashout_fees" } as AccountRef, creditMinor: fee, memo: "Fee" }] : []),
      ];
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: date,
          source: { type: "money_movement", id },
          postingKey: `money:${id}`,
          description: `POS cash-out${payload.note ? `: ${payload.note}` : ""}`.slice(0, 240),
          lines,
        },
      );
      await tx.insert(moneyMovements).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        kind: "pos_cashout",
        amountMinor: amount,
        feeMinor: fee,
        feePaidBy: payload.feePaidBy,
        currencyCode: business.baseCurrencyCode,
        movementDate: date,
        note: payload.note || null,
        journalEntryId: posted.entryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
      });
      await this.record(tx, tenant, business.id, branch.id, "money.pos_cashout", "money_movement", id, {
        amountMinor: amount.toString(),
        feeMinor: fee.toString(),
        feePaidBy: payload.feePaidBy,
        date,
      });
    });
    const [row] = await this.db.select().from(moneyMovements).where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.id, id)));
    return this.movementView(row as typeof moneyMovements.$inferSelect);
  }

  /**
   * The cash the drawer should hold today, for the shop this person would cash out from (ADR-053).
   * One number, so the counter can confirm giving out more. It does not open the cash page.
   */
  async drawerExpected(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id);
    const today = localDate(new Date(), business.timezone);
    await this.db.transaction((tx) => this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId));
    const accounts = await this.cashAccounts(this.db, tenant.tenantId, business.id, [branch.id]);
    const accountId = accounts.get(branch.id);
    let expected = 0n;
    if (accountId) {
      const [row] = await this.db
        .select({ balance: sql<string>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)::text` })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId)))
        .where(and(eq(journalLines.tenantId, tenant.tenantId), eq(journalLines.accountId, accountId), lte(journalEntries.entryDate, today)));
      expected = BigInt(row?.balance ?? "0");
    }
    return { expectedMinor: expected.toString(), currency: business.baseCurrencyCode.trim() };
  }

  async voidMovement(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = moneyReasonSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const [movement] = await tx
        .select()
        .from(moneyMovements)
        .where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.businessId, business.id), eq(moneyMovements.id, id)))
        .for("update")
        .limit(1);
      if (!movement || (tenant.membershipBranchId && movement.branchId !== tenant.membershipBranchId)) {
        throw new ApiError("NOT_FOUND", "Not found.", 404);
      }
      if (movement.status === "voided") throw new ApiError("ALREADY_VOIDED", "This has already been cancelled.", 409);
      if (movement.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, movement.journalEntryId, {
          entryDate: localDate(new Date(), business.timezone),
          reason: `Cancelled: ${reason}`,
        });
      }
      await tx
        .update(moneyMovements)
        .set({ status: "voided", voidedAt: new Date(), voidedBy: tenant.userId, voidReason: reason })
        .where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.id, id)));
      await this.record(tx, tenant, business.id, movement.branchId, "money.move_voided", "money_movement", id, { reason });
    });
    const [row] = await this.db.select().from(moneyMovements).where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.id, id)));
    return this.movementView(row as typeof moneyMovements.$inferSelect);
  }

  /* -------------------------------------------------------------- cash */

  /**
   * The cash in each shop's drawer on a day: what was there at the start, what came in and went out by cause
   * (sales, debt payments, expenses, the owner, the bank, counts), and what should be there now; with the day's
   * counts and money moves. Shop staff see their own shop.
   */
  async cashPosition(tenant: TenantContext, query: { date?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const date = isDay(query.date) ? query.date : today;
    if (date > today) throw new ApiError("VALIDATION_ERROR", "That day has not come yet.", 400);
    await this.db.transaction((tx) => this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId));
    const shopFilter = tenant.membershipBranchId ?? query.branchId;
    const shops = await this.db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      // Closed shops (ADR-032) are left out unless asked for by name, for their history.
      .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, business.id), ...(shopFilter ? [eq(branches.id, shopFilter)] : [isNull(branches.closedAt)])))
      .orderBy(asc(branches.createdAt));
    if (shopFilter && shops.length === 0) throw new ApiError("BRANCH_NOT_FOUND", "Shop was not found.", 404);
    const accounts = await this.cashAccounts(this.db, tenant.tenantId, business.id, shops.map((shop) => shop.id));
    const accountIds = [...accounts.values()];
    const opening = new Map<string, bigint>();
    const flows = new Map<string, Map<CashFlowKind, { inMinor: bigint; outMinor: bigint }>>();
    if (accountIds.length > 0) {
      const before = await this.db
        .select({ accountId: journalLines.accountId, balance: sql<string>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)::text` })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId)))
        .where(and(eq(journalLines.tenantId, tenant.tenantId), inArray(journalLines.accountId, accountIds), lt(journalEntries.entryDate, date)))
        .groupBy(journalLines.accountId);
      for (const row of before) opening.set(row.accountId, BigInt(row.balance));
      const onDay = await this.db
        .select({
          accountId: journalLines.accountId,
          sourceType: journalEntries.sourceType,
          kind: moneyMovements.kind,
          debit: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)::text`,
          credit: sql<string>`coalesce(sum(${journalLines.creditMinor}), 0)::text`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId)))
        .leftJoin(moneyMovements, and(eq(moneyMovements.tenantId, journalEntries.tenantId), eq(moneyMovements.id, journalEntries.sourceId)))
        .where(and(eq(journalLines.tenantId, tenant.tenantId), inArray(journalLines.accountId, accountIds), eq(journalEntries.entryDate, date)))
        .groupBy(journalLines.accountId, journalEntries.sourceType, moneyMovements.kind);
      for (const row of onDay) {
        const kind: CashFlowKind = row.sourceType === "money_movement" && row.kind ? MOVEMENT_FLOW[row.kind as MoneyMovementKind] : (SOURCE_FLOW[row.sourceType] ?? "other");
        const byKind = flows.get(row.accountId) ?? new Map();
        const entry = byKind.get(kind) ?? { inMinor: 0n, outMinor: 0n };
        entry.inMinor += BigInt(row.debit);
        entry.outMinor += BigInt(row.credit);
        byKind.set(kind, entry);
        flows.set(row.accountId, byKind);
      }
    }
    const [counts, moves] = await Promise.all([
      this.db
        .select({
          id: cashCounts.id,
          branchId: cashCounts.branchId,
          at: cashCounts.createdAt,
          expectedMinor: cashCounts.expectedMinor,
          countedMinor: cashCounts.countedMinor,
          differenceMinor: cashCounts.differenceMinor,
          note: cashCounts.note,
          by: users.displayName,
        })
        .from(cashCounts)
        .leftJoin(users, eq(users.id, cashCounts.createdBy))
        .where(and(eq(cashCounts.tenantId, tenant.tenantId), eq(cashCounts.businessId, business.id), eq(cashCounts.countDate, date)))
        .orderBy(desc(cashCounts.createdAt)),
      this.db
        .select()
        .from(moneyMovements)
        .where(and(eq(moneyMovements.tenantId, tenant.tenantId), eq(moneyMovements.businessId, business.id), eq(moneyMovements.movementDate, date)))
        .orderBy(desc(moneyMovements.createdAt)),
    ]);
    return {
      currency: business.baseCurrencyCode.trim(),
      date,
      today,
      shops: shops.map((shop) => {
        const accountId = accounts.get(shop.id);
        const start = (accountId && opening.get(accountId)) || 0n;
        const byKind = (accountId && flows.get(accountId)) || new Map<CashFlowKind, { inMinor: bigint; outMinor: bigint }>();
        let totalIn = 0n;
        let totalOut = 0n;
        // Always in the same order: sales first, counts last.
        const ordered = [...byKind.entries()].sort(([a], [b]) => CASH_FLOW_KINDS.indexOf(a) - CASH_FLOW_KINDS.indexOf(b));
        const lines = ordered.map(([kind, amounts]) => {
          totalIn += amounts.inMinor;
          totalOut += amounts.outMinor;
          return { kind, inMinor: amounts.inMinor.toString(), outMinor: amounts.outMinor.toString() };
        });
        return {
          branchId: shop.id,
          name: shop.name,
          openingMinor: start.toString(),
          inMinor: totalIn.toString(),
          outMinor: totalOut.toString(),
          expectedMinor: (start + totalIn - totalOut).toString(),
          flows: lines,
          counts: counts
            .filter((count) => count.branchId === shop.id)
            .map((count) => ({
              id: count.id,
              at: count.at.toISOString(),
              by: count.by,
              note: count.note,
              expectedMinor: count.expectedMinor.toString(),
              countedMinor: count.countedMinor.toString(),
              differenceMinor: count.differenceMinor.toString(),
            })),
          moves: moves.filter((move) => move.branchId === shop.id).map((move) => this.movementView(move)),
        };
      }),
    };
  }

  /**
   * Records a count of a shop's drawer. What was expected is worked out here, at this moment; any difference is
   * posted to "Cash short or over", so the drawer's expected cash starts again from what was counted. Whoever
   * counts without cash.expected.read (a cashier) is not told what was expected or the difference: a blind count.
   */
  async countCash(tenant: TenantContext, raw: unknown) {
    const payload = cashCountSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select().from(cashCounts).where(eq(cashCounts.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.countView(tenant, taken);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    const counted = BigInt(payload.countedMinor);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      // One count at a time per shop, so two counts cannot both read the same expected cash.
      await tx.execute(sql`SELECT id FROM branches WHERE tenant_id = ${tenant.tenantId} AND id = ${branch.id} FOR UPDATE`);
      await this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId);
      const accountId = (await this.cashAccounts(tx, tenant.tenantId, business.id, [branch.id])).get(branch.id);
      if (!accountId) throw new ApiError("LEDGER_ACCOUNT_MISSING", "This shop has no cash account.", 500);
      const [row] = await tx
        .select({ balance: sql<string>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)::text` })
        .from(journalLines)
        .where(and(eq(journalLines.tenantId, tenant.tenantId), eq(journalLines.accountId, accountId)));
      const expected = BigInt(row?.balance ?? "0");
      const difference = counted - expected;
      const date = localDate(new Date(), business.timezone);
      let journalEntryId: string | null = null;
      if (difference !== 0n) {
        const short = difference < 0n;
        const amount = short ? -difference : difference;
        const posted = await this.ledger.post(
          tx,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          {
            businessId: business.id,
            branchId: branch.id,
            entryDate: date,
            source: { type: "cash_count", id },
            postingKey: `cash-count:${id}`,
            description: `Cash count at ${branch.name}: ${short ? "short" : "over"}`.slice(0, 240),
            lines: short
              ? [
                  { account: { role: "cash_over_short" }, debitMinor: amount, memo: "Short" },
                  { account: { id: accountId }, creditMinor: amount },
                ]
              : [
                  { account: { id: accountId }, debitMinor: amount },
                  // Cash found is not profit (ADR-038): it is held until the owner knows where it came from.
                  { account: { role: "not_sales_money" }, creditMinor: amount, memo: "Over" },
                ],
          },
        );
        journalEntryId = posted.entryId;
      }
      await tx.insert(cashCounts).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        countDate: date,
        expectedMinor: expected,
        countedMinor: counted,
        differenceMinor: difference,
        currencyCode: business.baseCurrencyCode,
        note: payload.note || null,
        journalEntryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
      });
      await this.record(tx, tenant, business.id, branch.id, "cash.counted", "cash_count", id, {
        countedMinor: counted.toString(),
        expectedMinor: expected.toString(),
        differenceMinor: difference.toString(),
      });
    });
    const [saved] = await this.db.select().from(cashCounts).where(and(eq(cashCounts.tenantId, tenant.tenantId), eq(cashCounts.id, id)));
    return this.countView(tenant, saved as typeof cashCounts.$inferSelect);
  }

  /* -------------------------------------------------------------- profit */

  /**
   * Profit between two days (inclusive), from the ledger: sales less discounts, less what the goods sold cost, plus
   * other money in, less running costs (including stock lost, bank charges and cash short). One line per day for
   * ranges up to two months. Shop staff see their own shop; others can pick one.
   */
  async profit(tenant: TenantContext, query: { from?: string; to?: string; branchId?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const to = isDay(query.to) ? query.to : today;
    const from = isDay(query.from) ? query.from : to;
    this.assertRange(from, to, PROFIT_MAX_DAYS);
    const shop = tenant.membershipBranchId ?? query.branchId;
    const rows = await this.db
      .select({
        day: journalEntries.entryDate,
        accountId: ledgerAccounts.id,
        name: ledgerAccounts.name,
        role: ledgerAccounts.role,
        type: ledgerAccounts.accountType,
        debit: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)::text`,
        // Cash counted over before ADR-038 was posted against "Cash short or over"; it is not profit either.
        credit: sql<string>`coalesce(sum(case when ${journalEntries.sourceType} = 'cash_count' and ${ledgerAccounts.role} = 'cash_over_short' then 0 else ${journalLines.creditMinor} end), 0)::text`,
        countedOver: sql<string>`coalesce(sum(case when ${journalEntries.sourceType} = 'cash_count' and ${ledgerAccounts.role} = 'cash_over_short' then ${journalLines.creditMinor} else 0 end), 0)::text`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId)))
      .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.tenantId, journalLines.tenantId), eq(ledgerAccounts.id, journalLines.accountId)))
      .where(
        and(
          eq(journalLines.tenantId, tenant.tenantId),
          eq(journalEntries.businessId, business.id),
          gte(journalEntries.entryDate, from),
          lte(journalEntries.entryDate, to),
          or(inArray(ledgerAccounts.accountType, ["income", "expense"]), eq(ledgerAccounts.role, "not_sales_money")),
          ...(shop ? [eq(journalEntries.branchId, shop)] : []),
        ),
      )
      .groupBy(journalEntries.entryDate, ledgerAccounts.id, ledgerAccounts.name, ledgerAccounts.role, ledgerAccounts.accountType);

    // Profit comes only from sales (ADR-038), plus fees for POS cash-outs. Money in that is not a sale is shown
    // apart and left out.
    type Totals = { sales: bigint; discounts: bigint; returns: bigint; cost: bigint; posFees: bigint; expenses: bigint; notFromSales: bigint };
    const empty = (): Totals => ({ sales: 0n, discounts: 0n, returns: 0n, cost: 0n, posFees: 0n, expenses: 0n, notFromSales: 0n });
    const all = empty();
    const byDay = new Map<string, Totals>();
    const byExpense = new Map<string, { name: string; amount: bigint }>();
    for (const row of rows) {
      const debit = BigInt(row.debit);
      const credit = BigInt(row.credit);
      const day = byDay.get(row.day) ?? empty();
      const add = (key: keyof Totals, amount: bigint) => {
        all[key] += amount;
        day[key] += amount;
      };
      add("notFromSales", BigInt(row.countedOver));
      if (row.role === "not_sales_money" || row.role === "other_income") {
        add("notFromSales", credit - debit);
      } else if (row.type === "income") {
        if (SALES_ROLES.has(row.role)) add("sales", credit - debit);
        else if (row.role === "discounts") add("discounts", debit - credit);
        else if (row.role === "sales_returns") add("returns", debit - credit);
        else if (row.role === "pos_cashout_fees") add("posFees", credit - debit);
        else add("notFromSales", credit - debit);
      } else if (COST_OF_SALES_ROLES.has(row.role)) {
        add("cost", debit - credit);
      } else {
        add("expenses", debit - credit);
        const entry = byExpense.get(row.accountId) ?? { name: row.name, amount: 0n };
        entry.amount += debit - credit;
        byExpense.set(row.accountId, entry);
      }
      byDay.set(row.day, day);
    }
    const view = (totals: Totals) => {
      const netSales = totals.sales - totals.discounts - totals.returns;
      const gross = netSales - totals.cost;
      return {
        salesMinor: totals.sales.toString(),
        discountsMinor: totals.discounts.toString(),
        returnsMinor: totals.returns.toString(),
        netSalesMinor: netSales.toString(),
        costOfSalesMinor: totals.cost.toString(),
        grossProfitMinor: gross.toString(),
        posCashoutFeesMinor: totals.posFees.toString(),
        expensesMinor: totals.expenses.toString(),
        profitMinor: (gross + totals.posFees - totals.expenses).toString(),
        notFromSalesMinor: totals.notFromSales.toString(),
      };
    };
    const span = daysBetween(from, to) + 1;
    const days =
      span <= PROFIT_DAILY_MAX_DAYS
        ? Array.from({ length: span }, (_, index) => {
            const date = addDays(from, index);
            return { date, ...view(byDay.get(date) ?? empty()) };
          }).reverse()
        : null;
    const [waiting] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, tenant.tenantId),
          eq(expenses.businessId, business.id),
          eq(expenses.status, "awaiting_approval"),
          gte(expenses.expenseDate, from),
          lte(expenses.expenseDate, to),
          ...(shop ? [eq(expenses.branchId, shop)] : []),
        ),
      );
    const figures = view(all);
    const coverage = await this.costCoverage(tenant, business, from, to, shop);
    const goods = BigInt(coverage.goods);
    const uncosted = BigInt(coverage.uncosted);
    const profitStatus = goods === 0n || uncosted === 0n ? "known" : uncosted === goods ? "unknown" : "partial";
    const knownProfit = BigInt(figures.profitMinor) - uncosted;
    const estimatedProfit = coverage.estimatedCost === null ? null : knownProfit + BigInt(coverage.covered) - BigInt(coverage.estimatedCost);
    return {
      currency: business.baseCurrencyCode.trim(),
      today,
      from,
      to,
      branchId: shop ?? null,
      ...figures,
      /** known: every goods line has a cost. partial: some do. unknown: none do. Profit is not invented (ADR-049). */
      profitStatus,
      uncostedSalesMinor: uncosted.toString(),
      costCoverageBps: goods === 0n ? 10000 : Number(((goods - uncosted) * 10000n) / goods),
      knownProfitMinor: knownProfit.toString(),
      estimatedProfitMinor: estimatedProfit?.toString() ?? null,
      expenses: [...byExpense.values()]
        .filter((entry) => entry.amount !== 0n)
        .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
        .map((entry) => ({ name: entry.name, amountMinor: entry.amount.toString() })),
      expensesAwaitingApproval: waiting?.count ?? 0,
      days,
    };
  }

  /**
   * How much of the period's goods sales have a cost on the line, and any cost the owner estimated later.
   * Estimates never change the ledger. A line with no cost and no estimate stays out of estimated profit.
   */
  private async costCoverage(tenant: TenantContext, business: Business, from: string, to: string, shop?: string) {
    const filters = [
      eq(saleLines.tenantId, tenant.tenantId),
      eq(sales.businessId, business.id),
      inArray(sales.status, ["completed", "awaiting_release"]),
      sql`(${sales.soldAt} AT TIME ZONE ${business.timezone})::date >= ${from}::date`,
      sql`(${sales.soldAt} AT TIME ZONE ${business.timezone})::date <= ${to}::date`,
      ...(shop ? [eq(sales.branchId, shop)] : []),
    ];
    const [row] = await this.db
      .select({
        goods: sql<string>`coalesce(sum(case when ${saleLines.lineKind} <> 'service' then ${saleLines.lineTotalMinor} else 0 end), 0)::text`,
        uncosted: sql<string>`coalesce(sum(case when ${saleLines.lineKind} <> 'service' and ${saleLines.costMinor} is null then ${saleLines.lineTotalMinor} else 0 end), 0)::text`,
      })
      .from(saleLines)
      .innerJoin(sales, and(eq(sales.tenantId, saleLines.tenantId), eq(sales.id, saleLines.saleId)))
      .where(and(...filters));
    const shopSql = shop ? sql`AND s.branch_id = ${shop}` : sql``;
    const estimated = await this.db.execute(sql`
      SELECT coalesce(sum(covered), 0)::text AS covered, coalesce(sum(cost), 0)::text AS cost, count(cost)::int AS hits
      FROM (
        SELECT sl.line_total_minor AS covered,
          (
            SELECT ce.estimated_cost_minor * sl.entered_quantity / 1000
            FROM cost_estimates ce
            LEFT JOIN saved_items si ON si.tenant_id = ce.tenant_id AND si.business_id = ce.business_id
              AND (si.id = ce.saved_item_id OR (ce.product_id IS NOT NULL AND si.product_id = ce.product_id))
            WHERE ce.tenant_id = sl.tenant_id AND ce.business_id = sl.business_id
              AND (s.sold_at AT TIME ZONE ${business.timezone})::date BETWEEN ce.period_start AND ce.period_end
              AND (
                (ce.product_id IS NOT NULL AND ce.product_id = sl.product_id)
                OR si.name_key = lower(btrim(regexp_replace(regexp_replace(sl.description, '\\s+', ' ', 'g'), '[.,;:!?]+$', '')))
              )
            ORDER BY ce.created_at DESC
            LIMIT 1
          ) AS cost
        FROM sale_lines sl
        JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
        WHERE sl.tenant_id = ${tenant.tenantId} AND s.business_id = ${business.id}
          AND s.status IN ('completed', 'awaiting_release')
          AND sl.line_kind <> 'service' AND sl.cost_minor IS NULL
          AND (s.sold_at AT TIME ZONE ${business.timezone})::date >= ${from}::date
          AND (s.sold_at AT TIME ZONE ${business.timezone})::date <= ${to}::date
          ${shopSql}
      ) lines
      WHERE cost IS NOT NULL
    `);
    const estimateRow = (Array.isArray(estimated) ? estimated[0] : (estimated as { rows?: { covered: string; cost: string; hits: number }[] }).rows?.[0]) as
      | { covered: string; cost: string; hits: number }
      | undefined;
    const hits = Number(estimateRow?.hits ?? 0);
    return {
      goods: row?.goods ?? "0",
      uncosted: row?.uncosted ?? "0",
      covered: hits > 0 ? (estimateRow?.covered ?? "0") : "0",
      estimatedCost: hits > 0 ? (estimateRow?.cost ?? "0") : null,
    };
  }

  /* -------------------------------------------------------------- helpers */

  private paidFromAccount(paidFrom: ExpensePaidFrom, branchId: string): AccountRef {
    if (paidFrom === "cash") return { role: "cash", branchId };
    if (paidFrom === "bank") return { role: "bank" };
    return { role: "capital" };
  }

  /** A day no later than today and at most a year back, in the business's time zone; today when not given. */
  private pastDay(value: string | undefined, business: Business, field: string) {
    const today = localDate(new Date(), business.timezone);
    if (!value) return today;
    if (!isDay(value)) throw new ApiError("VALIDATION_ERROR", "Use a date like 2026-11-18.", 400, [{ field, message: "Not a date." }]);
    if (value > today) throw new ApiError("VALIDATION_ERROR", "That day has not come yet.", 400, [{ field, message: "In the future." }]);
    if (daysBetween(value, today) > 366) throw new ApiError("VALIDATION_ERROR", "That is more than a year ago.", 400, [{ field, message: "Too long ago." }]);
    return value;
  }

  private assertRange(from: string, to: string, max: number) {
    if (from > to) throw new ApiError("VALIDATION_ERROR", "The first day must come before the last.", 400);
    if (daysBetween(from, to) + 1 > max) throw new ApiError("VALIDATION_ERROR", `Choose at most ${max} days.`, 400);
  }

  private async cashAccounts(executor: DbExecutor, tenantId: string, businessId: string, shopIds: string[]) {
    if (shopIds.length === 0) return new Map<string, string>();
    const rows = await executor
      .select({ id: ledgerAccounts.id, branchId: ledgerAccounts.branchId })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          eq(ledgerAccounts.businessId, businessId),
          eq(ledgerAccounts.role, "cash"),
          inArray(ledgerAccounts.branchId, shopIds),
        ),
      );
    return new Map(rows.map((row) => [row.branchId as string, row.id]));
  }

  private async requireExpense(executor: DbExecutor, tenant: TenantContext, id: string, lock = false): Promise<ExpenseRow> {
    const business = await requireBusiness(executor, tenant);
    const query = executor
      .select()
      .from(expenses)
      .where(and(eq(expenses.tenantId, tenant.tenantId), eq(expenses.businessId, business.id), eq(expenses.id, id)))
      .limit(1);
    const [expense] = lock ? await query.for("update") : await query;
    if (!expense || (tenant.membershipBranchId && expense.branchId !== tenant.membershipBranchId)) {
      throw new ApiError("NOT_FOUND", "Expense not found.", 404);
    }
    return expense;
  }

  private expenseRows(where: SQL, limit: number) {
    return this.db
      .select({
        id: expenses.id,
        categoryId: expenses.accountId,
        category: ledgerAccounts.name,
        branchId: expenses.branchId,
        shop: branches.name,
        amountMinor: sql<string>`${expenses.amountMinor}::text`,
        paidFrom: expenses.paidFrom,
        expenseDate: expenses.expenseDate,
        payee: expenses.payee,
        note: expenses.note,
        status: expenses.status,
        voidReason: expenses.voidReason,
        createdBy: expenses.createdBy,
        recordedBy: users.displayName,
        createdAt: expenses.createdAt,
      })
      .from(expenses)
      .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.tenantId, expenses.tenantId), eq(ledgerAccounts.id, expenses.accountId)))
      .innerJoin(branches, and(eq(branches.tenantId, expenses.tenantId), eq(branches.id, expenses.branchId)))
      .leftJoin(users, eq(users.id, expenses.createdBy))
      .where(where)
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(limit);
  }

  private expenseView(tenant: TenantContext, row: Awaited<ReturnType<MoneyService["expenseRows"]>>[number]) {
    const approver = tenant.permissions.includes(Permission.EXPENSES_APPROVE);
    return {
      ...row,
      status: row.status as ExpenseStatus,
      createdAt: row.createdAt.toISOString(),
      canApprove: approver && row.status === "awaiting_approval",
      canCancel: row.status !== "voided" && (approver || (row.createdBy === tenant.userId && row.status === "awaiting_approval")),
    };
  }

  private async presentExpense(tenant: TenantContext, id: string) {
    const [row] = await this.expenseRows(and(eq(expenses.tenantId, tenant.tenantId), eq(expenses.id, id)) as SQL, 1);
    if (!row) throw new ApiError("NOT_FOUND", "Expense not found.", 404);
    return this.expenseView(tenant, row);
  }

  private movementView(row: typeof moneyMovements.$inferSelect) {
    return {
      id: row.id,
      branchId: row.branchId,
      kind: row.kind as MoneyMovementKind,
      amountMinor: row.amountMinor.toString(),
      feeMinor: row.feeMinor.toString(),
      feePaidBy: row.feePaidBy ?? null,
      movementDate: row.movementDate,
      note: row.note,
      status: row.status,
      voidReason: row.voidReason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** A cashier who counted sees what they counted; the difference is for whoever may see the expected cash. */
  private countView(tenant: TenantContext, row: typeof cashCounts.$inferSelect) {
    const base = { id: row.id, branchId: row.branchId, countDate: row.countDate, countedMinor: row.countedMinor.toString(), at: row.createdAt.toISOString() };
    if (!tenant.permissions.includes(Permission.CASH_EXPECTED_READ)) return base;
    return { ...base, expectedMinor: row.expectedMinor.toString(), differenceMinor: row.differenceMinor.toString() };
  }

  private async record(
    executor: DbExecutor,
    tenant: TenantContext,
    businessId: string,
    branchId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType,
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
