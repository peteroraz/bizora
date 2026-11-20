import { Inject, Injectable } from "@nestjs/common";
import { IMPORT_MAX_ROWS, businessTypeFromIndustry, currencyDigits, reconcileSchema, statementImportSchema, type ImportRowResult, type ReconcileTarget } from "@bizora/contracts";
import { and, isNull, asc, desc, eq, gt, ilike, inArray, ne, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { zonedDateTime } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { customerPayments, customers, salePayments, sales, statementImports, statementLines, statementRules } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { PaymentService } from "../debtors/payment.service.js";
import { TransferService } from "../debtors/transfer.service.js";
import { findBranch, requireBusiness, resolveBranch, type BusinessRow } from "../inventory/inventory-scope.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";
import { fingerprint, nameScore, parseStatementRow, referenceMatches } from "./statement-parse.js";

type LineRow = typeof statementLines.$inferSelect;
type RuleRow = typeof statementRules.$inferSelect;
type Suggestion = { target: ReconcileTarget; confidence: "exact" | "likely" | "possible"; label: string; detail: Record<string, string | null> };

const PAGE_SIZE = 25;
const WINDOW_DAYS = 3;
const OPEN_SALES = ["awaiting_release", "completed"];

/**
 * Bank statements and the reconciliation inbox (ADR-020). Bizora reads statement lines of money in and records what
 * they were; it never moves money. Every match posts or links in one transaction and can be undone.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(TransferService) private readonly transfers: TransferService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Checks (dry run) or saves a statement. Money out is skipped until Sprint 7; lines seen before are skipped. */
  async importStatement(tenant: TenantContext, raw: unknown) {
    const payload = statementImportSchema.parse(raw);
    if (payload.rows.length > IMPORT_MAX_ROWS) {
      throw new ApiError("TOO_MANY_ROWS", `A statement can have at most ${IMPORT_MAX_ROWS} rows. Split the file by month.`, 400);
    }
    const business = await requireBusiness(this.db, tenant);
    const digits = currencyDigits(business.baseCurrencyCode.trim());
    const parsed = payload.rows.map((row) => parseStatementRow(row, digits));
    const seen = new Map<string, number>();
    const prints = parsed.map((row) => {
      if (row.kind !== "in") return null;
      const key = `${row.date}|${row.amount}|${row.description}|${row.reference ?? ""}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      return fingerprint(business.id, row, occurrence);
    });
    const known = new Set(
      (
        await this.db
          .select({ fingerprint: statementLines.fingerprint })
          .from(statementLines)
          .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, business.id), inArray(statementLines.fingerprint, prints.filter((print): print is string => Boolean(print)).concat(["-"]))))
      ).map((row) => row.fingerprint),
    );
    let outSkipped = 0;
    let duplicates = 0;
    const results: ImportRowResult[] = parsed.map((row, index) => {
      if (row.kind === "error") return { row: index + 1, status: "error", errors: row.errors };
      if (row.kind === "out") {
        outSkipped += 1;
        return { row: index + 1, status: "skip", message: "Money out: matching comes with money in and out (Sprint 7)." };
      }
      if (row.kind === "empty") return { row: index + 1, status: "skip", message: "No amount: skipped." };
      if (known.has(prints[index] as string)) {
        duplicates += 1;
        return { row: index + 1, status: "skip", message: "Already imported from an earlier statement." };
      }
      return { row: index + 1, status: "create", message: `Money in: ${row.amount / 100n} on ${row.date}.` };
    });
    const totals = { create: results.filter((r) => r.status === "create").length, update: 0, error: results.filter((r) => r.status === "error").length };
    if (payload.dryRun || totals.error > 0) return { committed: false, results, totals, autoMatched: 0 };

    let autoMatched = 0;
    await this.db.transaction(async (tx) => {
      const importId = newId();
      await tx.insert(statementImports).values({
        id: importId,
        tenantId: tenant.tenantId,
        businessId: business.id,
        accountLabel: payload.accountLabel,
        source: payload.source,
        linesNew: totals.create,
        linesDuplicate: duplicates,
        linesOutSkipped: outSkipped,
        createdBy: tenant.userId,
      });
      const rules = await this.rules(tx, tenant, business.id);
      for (const [index, row] of parsed.entries()) {
        if (row.kind !== "in" || results[index]?.status !== "create") continue;
        const [line] = await tx
          .insert(statementLines)
          .values({
            id: newId(),
            tenantId: tenant.tenantId,
            businessId: business.id,
            importId,
            accountLabel: payload.accountLabel,
            txnDate: row.date,
            description: row.description,
            reference: row.reference,
            amountMinor: row.amount,
            currencyCode: business.baseCurrencyCode.trim(),
            fingerprint: prints[index] as string,
          })
          .returning();
        if (line && (await this.autoMatch(tx, tenant, business, line, rules))) autoMatched += 1;
      }
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "statement.imported",
          entityType: "statement",
          entityId: importId,
          correlationId: tenant.correlationId,
          businessId: business.id,
          metadata: { account: payload.accountLabel, source: payload.source, lines: totals.create, duplicates, outSkipped, autoMatched },
        },
        tx,
      );
    });
    return { committed: true, results, totals, autoMatched };
  }

  /** The inbox: lines to check (with suggestions, best first) or lines already done. */
  async inbox(tenant: TenantContext, query: { status?: string; page?: number }) {
    const business = await requireBusiness(this.db, tenant);
    const done = query.status === "done";
    const filters: SQL[] = [eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, business.id), done ? inArray(statementLines.status, ["matched", "ignored"]) : eq(statementLines.status, "open")];
    const page = Math.max(1, query.page ?? 1);
    const [rows, counts] = await Promise.all([
      this.db
        .select({ line: statementLines, customerName: customers.name, paymentNumber: customerPayments.paymentNumber })
        .from(statementLines)
        .leftJoin(customers, and(eq(customers.tenantId, statementLines.tenantId), eq(customers.id, statementLines.customerId)))
        .leftJoin(customerPayments, and(eq(customerPayments.tenantId, statementLines.tenantId), eq(customerPayments.id, statementLines.customerPaymentId)))
        .where(and(...filters))
        .orderBy(...(done ? [desc(statementLines.matchedAt), desc(statementLines.id)] : [asc(statementLines.txnDate), asc(statementLines.id)]))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
      this.db
        .select({ status: statementLines.status, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${statementLines.amountMinor}), 0)` })
        .from(statementLines)
        .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, business.id)))
        .groupBy(statementLines.status),
    ]);
    const rules = done ? [] : await this.rules(this.db, tenant, business.id);
    const items = [];
    for (const { line, customerName, paymentNumber } of rows) {
      items.push({
        ...this.present(line),
        customerName,
        paymentNumber,
        ...(done ? {} : { suggestions: await this.suggest(this.db, tenant, business, line, rules) }),
      });
    }
    const count = (status: string) => counts.find((row) => row.status === status);
    return {
      currency: business.baseCurrencyCode.trim(),
      page,
      pageSize: PAGE_SIZE,
      counts: {
        open: Number(count("open")?.count ?? 0),
        openMinor: BigInt(count("open")?.total ?? 0).toString(),
        matched: Number(count("matched")?.count ?? 0),
        ignored: Number(count("ignored")?.count ?? 0),
      },
      items,
    };
  }

  /** How many statement lines wait to be checked, for Home and the Money page. */
  async counts(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const [row] = await this.db
      .select({ open: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${statementLines.amountMinor}), 0)` })
      .from(statementLines)
      .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, business.id), eq(statementLines.status, "open")));
    return { currency: business.baseCurrencyCode.trim(), open: Number(row?.open ?? 0), openMinor: BigInt(row?.total ?? 0).toString() };
  }

  /** Customers for a manual match: those who owe first, then anyone by name. */
  async customers(tenant: TenantContext, q: string | undefined) {
    const business = await requireBusiness(this.db, tenant);
    const owing = sql<string>`coalesce((SELECT sum(${sales.balanceMinor}) FROM ${sales} WHERE ${sales.tenantId} = ${customers.tenantId} AND ${sales.customerId} = ${customers.id} AND ${sales.balanceMinor} > 0 AND NOT ${sales.historyOnly} AND ${sales.status} IN ('awaiting_release', 'completed')), 0)`;
    const filters: SQL[] = [eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, business.id), isNull(customers.archivedAt)];
    if (q?.trim()) filters.push(ilike(customers.name, `%${q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`));
    const rows = await this.db
      .select({ id: customers.id, name: customers.name, owing })
      .from(customers)
      .where(and(...filters))
      .orderBy(sql`${owing} DESC`, asc(customers.name))
      .limit(20);
    return { items: rows.map((row) => ({ id: row.id, name: row.name, owingMinor: BigInt(row.owing).toString() })) };
  }

  async reconcile(tenant: TenantContext, lineId: string, raw: unknown) {
    const { target, rulePattern } = reconcileSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const line = await this.requireLine(tx, tenant, business.id, lineId);
      if (line.status !== "open") throw new ApiError("ALREADY_MATCHED", "This line has already been matched. Undo it first.", 409);
      let ruleId: string | null = null;
      if (rulePattern && target.kind !== "recorded_payment") ruleId = await this.saveRule(tx, tenant, business.id, rulePattern, target);
      await this.apply(tx, tenant, business, line, target, { auto: false, ruleId });
    });
    return this.line(tenant, lineId);
  }

  /** Puts a line back in the inbox, reversing whatever the match recorded. */
  async undo(tenant: TenantContext, lineId: string) {
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const line = await this.requireLine(tx, tenant, business.id, lineId);
      if (line.status === "open") throw new ApiError("NOT_MATCHED", "This line is not matched.", 409);
      if (line.createdPayment && line.customerPaymentId) await this.payments.voidIn(tx, tenant, line.customerPaymentId, `Bank line on ${line.txnDate} unmatched`);
      if (line.journalEntryId) {
        await this.ledger.reverse(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, line.journalEntryId, { entryDate: line.txnDate, reason: `Bank line on ${line.txnDate} unmatched` });
        // The transfer this line confirmed waits again (ADR-031).
        if (line.matchKind === "recorded_payment") await this.transfers.resetIn(tx, tenant, line.journalEntryId);
      }
      await tx
        .update(statementLines)
        .set({
          status: "open",
          matchKind: null,
          matchDetail: null,
          salePaymentId: null,
          customerPaymentId: null,
          createdPayment: false,
          customerId: null,
          journalEntryId: null,
          ruleId: null,
          autoMatched: false,
          note: null,
          matchedBy: null,
          matchedAt: null,
        })
        .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.id, line.id)));
      await this.record(tx, tenant, business.id, "statement.unmatched", line.id, { kind: line.matchKind, amountMinor: line.amountMinor.toString() });
    });
    return this.line(tenant, lineId);
  }

  async listRules(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.rules(this.db, tenant, business.id);
    return { items: rows.map((rule) => ({ id: rule.id, pattern: rule.pattern, target: rule.target, timesUsed: rule.timesUsed, createdAt: rule.createdAt })) };
  }

  async deleteRule(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const deleted = await this.db
      .delete(statementRules)
      .where(and(eq(statementRules.tenantId, tenant.tenantId), eq(statementRules.businessId, business.id), eq(statementRules.id, id)))
      .returning({ id: statementRules.id });
    if (deleted.length === 0) throw new ApiError("NOT_FOUND", "Rule not found.", 404);
    await this.record(this.db, tenant, business.id, "statement.rule_deleted", id, {});
    return { deleted: true };
  }

  // Matching ------------------------------------------------------------------------------------------------------------

  /** Exact matches post themselves: a recorded transfer whose reference is on the line, or a saved rule. */
  private async autoMatch(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, line: LineRow, rules: RuleRow[]) {
    const suggestions = await this.suggest(tx, tenant, business, line, rules);
    const exact = suggestions.find((suggestion) => suggestion.confidence === "exact");
    if (!exact) return false;
    // A savepoint: a rule that no longer fits leaves the line for a person to check, without failing the import.
    await tx.execute(sql`SAVEPOINT auto_match`);
    try {
      await this.apply(tx, tenant, business, line, exact.target, { auto: true, ruleId: exact.detail.ruleId ?? null });
      await tx.execute(sql`RELEASE SAVEPOINT auto_match`);
      return true;
    } catch {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT auto_match`);
      return false;
    }
  }

  private async suggest(executor: DbExecutor, tenant: TenantContext, business: BusinessRow, line: LineRow, rules: RuleRow[]): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];
    const window = sql`BETWEEN (${line.txnDate}::date - ${sql.raw(String(WINDOW_DAYS))}) AND (${line.txnDate}::date + ${sql.raw(String(WINDOW_DAYS))})`;
    const tz = business.timezone;

    // 1. Transfers already recorded at the counter, not yet seen on a statement.
    const saleTransfers = await executor
      .select({ id: salePayments.id, reference: salePayments.reference, number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`, customerName: customers.name, at: sql<string>`coalesce(${sales.collectedAt}, ${sales.soldAt})` })
      .from(salePayments)
      .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .where(
        and(
          eq(salePayments.tenantId, tenant.tenantId),
          eq(sales.businessId, business.id),
          eq(salePayments.method, "transfer"),
          ne(salePayments.confirmation, "not_received"),
          eq(salePayments.amountMinor, line.amountMinor),
          inArray(sales.status, OPEN_SALES),
          sql`(timezone(${tz}, coalesce(${sales.collectedAt}, ${sales.soldAt})))::date ${window}`,
          sql`NOT EXISTS (SELECT 1 FROM statement_lines linked WHERE linked.tenant_id = ${salePayments.tenantId} AND linked.sale_payment_id = ${salePayments.id})`,
        ),
      )
      .limit(5);
    for (const payment of saleTransfers) {
      suggestions.push({
        target: { kind: "recorded_payment", paymentType: "sale_payment", paymentId: payment.id },
        confidence: referenceMatches(payment.reference, line) ? "exact" : "likely",
        label: "recorded_sale",
        detail: { number: payment.number, customerName: payment.customerName, reference: payment.reference },
      });
    }
    const debtorTransfers = await executor
      .select({ id: customerPayments.id, reference: customerPayments.reference, number: customerPayments.paymentNumber, customerName: customers.name })
      .from(customerPayments)
      .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
      .where(
        and(
          eq(customerPayments.tenantId, tenant.tenantId),
          eq(customerPayments.businessId, business.id),
          eq(customerPayments.method, "transfer"),
          eq(customerPayments.status, "recorded"),
          eq(customerPayments.amountMinor, line.amountMinor),
          sql`(timezone(${tz}, ${customerPayments.receivedAt}))::date ${window}`,
          sql`NOT EXISTS (SELECT 1 FROM statement_lines linked WHERE linked.tenant_id = ${customerPayments.tenantId} AND linked.customer_payment_id = ${customerPayments.id})`,
        ),
      )
      .limit(5);
    for (const payment of debtorTransfers) {
      suggestions.push({
        target: { kind: "recorded_payment", paymentType: "customer_payment", paymentId: payment.id },
        confidence: referenceMatches(payment.reference, line) ? "exact" : "likely",
        label: "recorded_payment",
        detail: { number: payment.number, customerName: payment.customerName, reference: payment.reference },
      });
    }

    // 2. Saved rules.
    const description = line.description.toUpperCase();
    for (const rule of rules) {
      if (!description.includes(rule.pattern)) continue;
      suggestions.push({ target: rule.target as ReconcileTarget, confidence: "exact", label: "rule", detail: { pattern: rule.pattern, ruleId: rule.id } });
    }

    // 3. Debtors whose name is in the narration.
    if (line.description) {
      const owing = sql<string>`coalesce(sum(${sales.balanceMinor}), 0)`;
      const debtors = await executor
        .select({ id: customers.id, name: customers.name, owing })
        .from(sales)
        .innerJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.businessId, business.id), gt(sales.balanceMinor, 0n), eq(sales.historyOnly, false), inArray(sales.status, OPEN_SALES)))
        .groupBy(customers.id, customers.name)
        .limit(500);
      const scored = debtors
        .map((debtor) => ({ ...debtor, score: nameScore(debtor.name, line.description) }))
        .filter((debtor) => debtor.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      for (const debtor of scored) {
        suggestions.push({
          target: { kind: "debtor", customerId: debtor.id },
          confidence: debtor.score === 1 ? "likely" : "possible",
          label: "debtor",
          detail: { customerName: debtor.name, owingMinor: BigInt(debtor.owing).toString() },
        });
      }
    }
    const rank = { exact: 0, likely: 1, possible: 2 };
    return suggestions.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  }

  private async apply(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, line: LineRow, target: ReconcileTarget, options: { auto: boolean; ruleId: string | null }) {
    const update: Partial<typeof statementLines.$inferInsert> = {
      status: target.kind === "ignored" ? "ignored" : "matched",
      matchKind: target.kind,
      matchedBy: tenant.userId,
      matchedAt: new Date(),
      autoMatched: options.auto,
      ruleId: options.ruleId,
    };
    const receivedAt = zonedDateTime(line.txnDate, "12:00", business.timezone);
    const reference = (line.reference ?? line.description).slice(0, 80) || undefined;

    switch (target.kind) {
      case "recorded_payment": {
        if (target.paymentType === "sale_payment") {
          const [payment] = await tx
            .select({ id: salePayments.id, amount: salePayments.amountMinor, method: salePayments.method, businessId: sales.businessId })
            .from(salePayments)
            .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
            .where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.id, target.paymentId)))
            .limit(1);
          if (!payment || payment.businessId !== business.id || payment.method !== "transfer") throw new ApiError("NOT_FOUND", "Payment not found.", 404);
          if (payment.amount !== line.amountMinor) throw new ApiError("AMOUNT_MISMATCH", "The amounts are different, so this is not the same transfer.", 400);
          update.salePaymentId = payment.id;
        } else {
          const [payment] = await tx
            .select()
            .from(customerPayments)
            .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.businessId, business.id), eq(customerPayments.id, target.paymentId), eq(customerPayments.status, "recorded")))
            .limit(1);
          if (!payment || payment.method !== "transfer") throw new ApiError("NOT_FOUND", "Payment not found.", 404);
          if (payment.amountMinor !== line.amountMinor) throw new ApiError("AMOUNT_MISMATCH", "The amounts are different, so this is not the same transfer.", 400);
          update.customerPaymentId = payment.id;
          update.customerId = payment.customerId;
        }
        update.matchDetail = target.paymentType;
        // A transfer still waiting for confirmation is confirmed by the statement (ADR-031).
        {
          const confirmed = await this.transfers.confirmIn(tx, tenant, target.paymentType, target.paymentId, { entryDate: line.txnDate, via: "bank_statement" });
          if (confirmed) update.journalEntryId = confirmed;
        }
        break;
      }
      case "debtor": {
        const owing = await this.owing(tx, tenant.tenantId, business.id, target.customerId);
        const toDebts = owing < line.amountMinor ? owing : line.amountMinor;
        const advance = line.amountMinor - toDebts;
        if (toDebts > 0n) {
          const paymentId = newId();
          await this.payments.recordIn(tx, tenant, target.customerId, { id: paymentId, amount: toDebts, method: "transfer", reference, note: `Bank statement: ${line.accountLabel}`, receivedAt, source: "statement" });
          update.customerPaymentId = paymentId;
          update.createdPayment = true;
        }
        // More than they owe: the rest is kept as their advance, never as income.
        if (advance > 0n) update.journalEntryId = await this.post(tx, tenant, business, line, { role: "customer_deposits" }, advance, "Customer advance");
        update.customerId = target.customerId;
        update.matchDetail = advance > 0n ? (toDebts > 0n ? "debt_and_advance" : "advance") : "debt";
        break;
      }
      case "advance": {
        await this.requireCustomer(tx, tenant, business.id, target.customerId);
        update.journalEntryId = await this.post(tx, tenant, business, line, { role: "customer_deposits" }, line.amountMinor, "Customer advance");
        update.customerId = target.customerId;
        break;
      }
      case "money_in": {
        const role = target.category === "owner_capital" ? "capital" : target.category === "other_income" ? "not_sales_money" : businessTypeFromIndustry(business.industryCode) === "services" ? "service_income" : "sales";
        update.journalEntryId = await this.post(tx, tenant, business, line, { role }, line.amountMinor, target.category);
        update.matchDetail = target.category;
        break;
      }
      case "own_transfer": {
        // Money moving between the business's own accounts is never income.
        let account: PostingLine["account"];
        if (target.source === "pos_settlement") account = { role: "pos_clearing" };
        else if (target.source === "cash_deposit") {
          const branch = target.branchId ? await findBranch(tx, tenant, business.id, target.branchId) : await resolveBranch(tx, tenant, business.id);
          account = { role: "cash", branchId: branch.id };
        } else account = { role: "transfer_clearing" };
        update.journalEntryId = await this.post(tx, tenant, business, line, account, line.amountMinor, target.source);
        update.matchDetail = target.source;
        break;
      }
      case "ignored": {
        update.note = target.reason;
        break;
      }
    }
    await tx.update(statementLines).set(update).where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.id, line.id)));
    if (options.ruleId) {
      await tx.update(statementRules).set({ timesUsed: sql`${statementRules.timesUsed} + 1` }).where(and(eq(statementRules.tenantId, tenant.tenantId), eq(statementRules.id, options.ruleId)));
    }
    await this.record(tx, tenant, business.id, "statement.matched", line.id, { kind: target.kind, detail: update.matchDetail ?? null, amountMinor: line.amountMinor.toString(), auto: options.auto });
  }

  /** Dr bank, Cr the given account, on the statement date. */
  private async post(tx: DbExecutor, tenant: TenantContext, business: BusinessRow, line: LineRow, credit: PostingLine["account"], amount: bigint, memo: string) {
    const branch = await resolveBranch(tx, tenant, business.id);
    const posted = await this.ledger.post(
      tx,
      { tenantId: tenant.tenantId, userId: tenant.userId },
      {
        businessId: business.id,
        branchId: branch.id,
        entryDate: line.txnDate,
        source: { type: "statement_line", id: line.id },
        postingKey: `statement:${line.id}:${newId()}`,
        description: `Bank ${line.accountLabel}: ${line.description}`.slice(0, 240),
        lines: [
          { account: { role: "bank" }, debitMinor: amount, memo: line.reference ?? undefined },
          { account: credit, creditMinor: amount, memo },
        ],
      },
    );
    return posted.entryId;
  }

  // Helpers ---------------------------------------------------------------------------------------------------------

  private async owing(executor: DbExecutor, tenantId: string, businessId: string, customerId: string) {
    const [row] = await executor
      .select({ owing: sql<string>`coalesce(sum(${sales.balanceMinor}), 0)` })
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.businessId, businessId), eq(sales.customerId, customerId), gt(sales.balanceMinor, 0n), eq(sales.historyOnly, false), inArray(sales.status, OPEN_SALES)));
    return BigInt(row?.owing ?? 0);
  }

  private async saveRule(tx: DbExecutor, tenant: TenantContext, businessId: string, pattern: string, target: ReconcileTarget) {
    const normalized = pattern.trim().toUpperCase().replace(/\s+/g, " ");
    const id = newId();
    const [saved] = await tx
      .insert(statementRules)
      .values({ id, tenantId: tenant.tenantId, businessId, pattern: normalized, target: target as unknown as Record<string, unknown>, createdBy: tenant.userId })
      .onConflictDoUpdate({ target: [statementRules.tenantId, statementRules.businessId, statementRules.pattern], set: { target: target as unknown as Record<string, unknown> } })
      .returning({ id: statementRules.id });
    await this.record(tx, tenant, businessId, "statement.rule_saved", saved?.id ?? id, { pattern: normalized, kind: target.kind });
    return saved?.id ?? id;
  }

  private rules(executor: DbExecutor, tenant: TenantContext, businessId: string) {
    return executor.select().from(statementRules).where(and(eq(statementRules.tenantId, tenant.tenantId), eq(statementRules.businessId, businessId))).orderBy(desc(statementRules.timesUsed));
  }

  private async requireLine(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [line] = await executor
      .select()
      .from(statementLines)
      .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, businessId), eq(statementLines.id, id)))
      .limit(1)
      .for("update");
    if (!line) throw new ApiError("NOT_FOUND", "Statement line not found.", 404);
    return line;
  }

  private async requireCustomer(executor: DbExecutor, tenant: TenantContext, businessId: string, customerId: string) {
    const [customer] = await executor.select({ id: customers.id }).from(customers).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.businessId, businessId), eq(customers.id, customerId))).limit(1);
    if (!customer) throw new ApiError("CUSTOMER_NOT_FOUND", "Customer not found.", 404);
  }

  private async line(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const [row] = await this.db
      .select({ line: statementLines, customerName: customers.name, paymentNumber: customerPayments.paymentNumber })
      .from(statementLines)
      .leftJoin(customers, and(eq(customers.tenantId, statementLines.tenantId), eq(customers.id, statementLines.customerId)))
      .leftJoin(customerPayments, and(eq(customerPayments.tenantId, statementLines.tenantId), eq(customerPayments.id, statementLines.customerPaymentId)))
      .where(and(eq(statementLines.tenantId, tenant.tenantId), eq(statementLines.businessId, business.id), eq(statementLines.id, id)))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Statement line not found.", 404);
    const rules = row.line.status === "open" ? await this.rules(this.db, tenant, business.id) : [];
    return {
      line: {
        ...this.present(row.line),
        customerName: row.customerName,
        paymentNumber: row.paymentNumber,
        ...(row.line.status === "open" ? { suggestions: await this.suggest(this.db, tenant, business, row.line, rules) } : {}),
      },
    };
  }

  private present(line: LineRow) {
    return {
      id: line.id,
      accountLabel: line.accountLabel,
      date: line.txnDate,
      description: line.description,
      reference: line.reference,
      amountMinor: line.amountMinor.toString(),
      status: line.status,
      matchKind: line.matchKind,
      matchDetail: line.matchDetail,
      autoMatched: line.autoMatched,
      note: line.note,
      matchedAt: line.matchedAt,
    };
  }

  private async record(executor: DbExecutor, tenant: TenantContext, businessId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType: "statement_line", entityId, correlationId: tenant.correlationId, businessId, metadata },
      executor,
    );
  }
}
