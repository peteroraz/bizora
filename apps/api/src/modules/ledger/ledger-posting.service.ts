import { Inject, Injectable } from "@nestjs/common";
import type { LedgerRole } from "@bizora/contracts";
import { convert, money } from "@bizora/money";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { businesses, journalEntries, journalLines, ledgerAccounts, ledgerPeriods } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { ChartOfAccountsService } from "./chart-of-accounts.service.js";

/** Find an account by what it is for (cash needs the shop) or by its code (needed for expense categories). */
export type AccountRef = { role: LedgerRole; branchId?: string | null } | { code: string } | { id: string };

export type PostingLine = {
  account: AccountRef;
  debitMinor?: bigint;
  creditMinor?: bigint;
  /** For a foreign-currency amount: the original amount and the rate the trader entered. The line amount is in base currency. */
  original?: { currencyCode: string; amountMinor: bigint; fxRate: string };
  memo?: string;
};

export type PostingRequest = {
  businessId: string;
  branchId?: string | null;
  /** YYYY-MM-DD in the business's timezone. */
  entryDate: string;
  /** The document this entry records: a sale, payment, expense, stock movement or reconciliation. */
  source: { type: string; id: string };
  /** Unique per organization. Posting the same key twice returns the first entry (safe for retries and sync). */
  postingKey: string;
  description: string;
  lines: PostingLine[];
};

export type PostingActor = { tenantId: string; userId: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function periodStartOf(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function assertDate(date: string) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!DATE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ApiError("LEDGER_INVALID", `Not a valid date: ${date}`, 422);
  }
}

/**
 * The only way anything writes to the ledger (ADR-013). Modules call post() inside the transaction that saves their
 * document, so the document and its entry are saved together or not at all. The database enforces the same rules
 * again: balanced entries, no edits or deletes, no postings into locked periods, accounts from the same business.
 */
@Injectable()
export class LedgerPostingService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(ChartOfAccountsService) private readonly chart: ChartOfAccountsService,
  ) {}

  async post(executor: DbExecutor, actor: PostingActor, request: PostingRequest): Promise<{ entryId: string; created: boolean }> {
    this.validate(request);
    const [existing] = await executor
      .select({ id: journalEntries.id, sourceType: journalEntries.sourceType, sourceId: journalEntries.sourceId })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, actor.tenantId), eq(journalEntries.postingKey, request.postingKey)))
      .limit(1);
    if (existing) {
      if (existing.sourceType !== request.source.type || existing.sourceId !== request.source.id) {
        throw new ApiError("POSTING_KEY_CONFLICT", "This posting key belongs to a different document.", 409);
      }
      return { entryId: existing.id, created: false };
    }
    const entryId = await this.write(executor, actor, request, null);
    return { entryId, created: true };
  }

  /** Cancels an entry by posting its mirror image. The original stays untouched. */
  async reverse(
    executor: DbExecutor,
    actor: PostingActor,
    entryId: string,
    options: { entryDate: string; reason: string },
  ): Promise<{ entryId: string }> {
    const [original] = await executor
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, actor.tenantId), eq(journalEntries.id, entryId)))
      .limit(1);
    if (!original) throw new ApiError("NOT_FOUND", "Entry not found.", 404);
    const [already] = await executor
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, actor.tenantId), eq(journalEntries.reversesEntryId, entryId)))
      .limit(1);
    if (already) throw new ApiError("ALREADY_REVERSED", "This entry has already been reversed.", 409);
    const lines = await executor
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, actor.tenantId), eq(journalLines.entryId, entryId)))
      .orderBy(asc(journalLines.lineNo));
    const request: PostingRequest = {
      businessId: original.businessId,
      branchId: original.branchId,
      entryDate: options.entryDate,
      source: { type: original.sourceType, id: original.sourceId },
      postingKey: `reversal:${original.id}`,
      description: `Reversal: ${options.reason}`.slice(0, 240),
      lines: lines.map((line) => ({
        account: { id: line.accountId },
        debitMinor: line.creditMinor,
        creditMinor: line.debitMinor,
        ...(line.originalCurrencyCode && line.originalAmountMinor !== null && line.fxRate
          ? { original: { currencyCode: line.originalCurrencyCode, amountMinor: line.originalAmountMinor, fxRate: line.fxRate } }
          : {}),
        ...(line.memo ? { memo: line.memo } : {}),
      })),
    };
    this.validate(request);
    return { entryId: await this.write(executor, actor, request, original.id) };
  }

  /** Locks a month. Nothing can be posted into it afterwards, and it cannot be reopened. */
  async lockPeriod(executor: DbExecutor, actor: PostingActor, businessId: string, periodStart: string) {
    assertDate(periodStart);
    if (!periodStart.endsWith("-01")) throw new ApiError("LEDGER_INVALID", "A period starts on the first day of a month.", 422);
    await executor
      .insert(ledgerPeriods)
      .values({ tenantId: actor.tenantId, businessId, periodStart, status: "locked", lockedAt: new Date(), lockedBy: actor.userId })
      .onConflictDoUpdate({
        target: [ledgerPeriods.tenantId, ledgerPeriods.businessId, ledgerPeriods.periodStart],
        set: { status: "locked", lockedAt: new Date(), lockedBy: actor.userId },
      });
  }

  /** Total debits and credits per account up to a date. The two totals are always equal. */
  async trialBalance(tenantId: string, businessId: string, asOf?: string) {
    if (asOf) assertDate(asOf);
    await this.db.transaction((tx) => this.chart.ensure(tx, tenantId, businessId));
    const entryFilter = asOf ? lte(journalEntries.entryDate, asOf) : sql`true`;
    const rows = await this.db
      .select({
        id: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        type: ledgerAccounts.accountType,
        debit: sql<string>`coalesce(sum(case when ${journalEntries.id} is not null then ${journalLines.debitMinor} end), 0)`,
        credit: sql<string>`coalesce(sum(case when ${journalEntries.id} is not null then ${journalLines.creditMinor} end), 0)`,
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, and(eq(journalLines.tenantId, ledgerAccounts.tenantId), eq(journalLines.accountId, ledgerAccounts.id)))
      .leftJoin(
        journalEntries,
        and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId), entryFilter),
      )
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.businessId, businessId)))
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.accountType)
      .orderBy(asc(ledgerAccounts.code));
    const accounts = rows.map((row) => {
      const debitMinor = BigInt(row.debit);
      const creditMinor = BigInt(row.credit);
      return { ...row, debitMinor, creditMinor, balanceMinor: debitMinor - creditMinor };
    });
    const totalDebitMinor = accounts.reduce((sum, row) => sum + row.debitMinor, 0n);
    const totalCreditMinor = accounts.reduce((sum, row) => sum + row.creditMinor, 0n);
    return { accounts, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
  }

  private validate(request: PostingRequest) {
    assertDate(request.entryDate);
    if (!request.postingKey || request.postingKey.length > 160) throw new ApiError("LEDGER_INVALID", "A posting key is required.", 422);
    if (!request.description.trim()) throw new ApiError("LEDGER_INVALID", "A description is required.", 422);
    if (request.lines.length < 2) throw new ApiError("LEDGER_UNBALANCED", "An entry needs at least two lines.", 422);
    let debits = 0n;
    let credits = 0n;
    for (const line of request.lines) {
      const debit = line.debitMinor ?? 0n;
      const credit = line.creditMinor ?? 0n;
      if (debit < 0n || credit < 0n || (debit === 0n) === (credit === 0n)) {
        throw new ApiError("LEDGER_INVALID", "Each line must have either a debit or a credit above zero.", 422);
      }
      debits += debit;
      credits += credit;
    }
    if (debits !== credits) {
      throw new ApiError("LEDGER_UNBALANCED", `Debits (${debits}) and credits (${credits}) must be equal.`, 422);
    }
  }

  private async write(executor: DbExecutor, actor: PostingActor, request: PostingRequest, reversesEntryId: string | null) {
    const [business] = await executor
      .select({ baseCurrencyCode: businesses.baseCurrencyCode })
      .from(businesses)
      .where(and(eq(businesses.tenantId, actor.tenantId), eq(businesses.id, request.businessId)))
      .limit(1);
    if (!business) throw new ApiError("NOT_FOUND", "Business not found.", 404);
    const base = business.baseCurrencyCode.trim();

    for (const line of request.lines) {
      if (!line.original) continue;
      const amount = line.debitMinor || line.creditMinor || 0n;
      if (line.original.currencyCode === base) {
        throw new ApiError("LEDGER_INVALID", "Only foreign-currency lines carry an original amount.", 422);
      }
      const converted = convert(money(line.original.amountMinor, line.original.currencyCode), base, line.original.fxRate, request.entryDate);
      if (converted.baseAmountMinor !== amount) {
        throw new ApiError(
          "LEDGER_FX_MISMATCH",
          `The ${base} amount (${amount}) must equal the original amount times the rate (${converted.baseAmountMinor}).`,
          422,
        );
      }
    }

    const accountIds = await this.resolveAccounts(executor, actor, request);

    const periodStart = periodStartOf(request.entryDate);
    await executor
      .insert(ledgerPeriods)
      .values({ tenantId: actor.tenantId, businessId: request.businessId, periodStart })
      .onConflictDoNothing();
    const [period] = await executor
      .select({ status: ledgerPeriods.status })
      .from(ledgerPeriods)
      .where(
        and(
          eq(ledgerPeriods.tenantId, actor.tenantId),
          eq(ledgerPeriods.businessId, request.businessId),
          eq(ledgerPeriods.periodStart, periodStart),
        ),
      )
      .limit(1);
    if (period?.status === "locked") {
      throw new ApiError("PERIOD_LOCKED", "That month is closed. Record the correction in the current month.", 409);
    }

    const entryId = newId();
    await executor.insert(journalEntries).values({
      id: entryId,
      tenantId: actor.tenantId,
      businessId: request.businessId,
      branchId: request.branchId ?? null,
      entryDate: request.entryDate,
      periodStart,
      currencyCode: base,
      sourceType: request.source.type,
      sourceId: request.source.id,
      postingKey: request.postingKey,
      description: request.description.trim().slice(0, 240),
      reversesEntryId,
      createdBy: actor.userId,
    });
    await executor.insert(journalLines).values(
      request.lines.map((line, index) => ({
        id: newId(),
        tenantId: actor.tenantId,
        businessId: request.businessId,
        entryId,
        accountId: accountIds[index] as string,
        lineNo: index + 1,
        debitMinor: line.debitMinor ?? 0n,
        creditMinor: line.creditMinor ?? 0n,
        originalCurrencyCode: line.original?.currencyCode ?? null,
        originalAmountMinor: line.original?.amountMinor ?? null,
        fxRate: line.original?.fxRate ?? null,
        memo: line.memo?.slice(0, 240) ?? null,
      })),
    );
    return entryId;
  }

  private async resolveAccounts(executor: DbExecutor, actor: PostingActor, request: PostingRequest): Promise<string[]> {
    const load = () =>
      executor
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.tenantId, actor.tenantId), eq(ledgerAccounts.businessId, request.businessId)));
    const find = (accounts: (typeof ledgerAccounts.$inferSelect)[], ref: AccountRef) => {
      if ("id" in ref) return accounts.filter((account) => account.id === ref.id);
      if ("code" in ref) return accounts.filter((account) => account.code === ref.code);
      const branchId = ref.branchId ?? request.branchId ?? null;
      return accounts.filter(
        (account) => account.role === ref.role && (ref.role !== "cash" || account.branchId === branchId),
      );
    };
    let accounts = await load();
    if (request.lines.some((line) => find(accounts, line.account).length === 0)) {
      await this.chart.ensure(executor, actor.tenantId, request.businessId, actor.userId);
      accounts = await load();
    }
    return request.lines.map((line) => {
      const matches = find(accounts, line.account);
      const label = JSON.stringify(line.account);
      if (matches.length === 0) throw new ApiError("LEDGER_ACCOUNT_NOT_FOUND", `No account matches ${label}.`, 422);
      if (matches.length > 1) throw new ApiError("LEDGER_ACCOUNT_AMBIGUOUS", `More than one account matches ${label}; use its code.`, 422);
      const account = matches[0] as typeof ledgerAccounts.$inferSelect;
      if (account.archivedAt) throw new ApiError("LEDGER_ACCOUNT_ARCHIVED", `Account ${account.code} is archived.`, 422);
      return account.id;
    });
  }
}
