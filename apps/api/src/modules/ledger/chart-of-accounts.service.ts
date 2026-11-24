import { Inject, Injectable } from "@nestjs/common";
import { businessTypeFromIndustry, cashAccountCode, cashAccountName, chartOfAccountsTemplate, type AccountTemplate } from "@bizora/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { ApiError, booksCouldNotSave } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, ledgerAccounts } from "../../db/schema.js";
import { DB } from "../../tokens.js";

/**
 * Creates a business's chart of accounts from the template for its business type, plus one cash account per shop.
 * Safe to call any number of times: it only adds what is missing. Called before every posting and before reads,
 * so businesses and shops created before the ledger existed get their accounts the first time they need them.
 */
@Injectable()
export class ChartOfAccountsService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async ensure(executor: DbExecutor, tenantId: string, businessId: string, actorUserId: string | null = null) {
    // One request at a time creates this business's accounts. An advisory lock, not `FOR UPDATE` on the business row:
    // every insert that refers to the business holds a key-share lock on that row, so a row lock here deadlocked with
    // another request that had already taken a document number (5 products with stock at once, performance baseline).
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`chart:${businessId}`}, 0))`);
    const [business] = await executor
      .select({ industryCode: businesses.industryCode })
      .from(businesses)
      .where(and(eq(businesses.tenantId, tenantId), eq(businesses.id, businessId)))
      .limit(1);
    if (!business) throw new ApiError("NOT_FOUND", "Business not found.", 404);

    const existing = await executor
      .select({ code: ledgerAccounts.code, role: ledgerAccounts.role, branchId: ledgerAccounts.branchId })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.businessId, businessId)));
    const codes = new Set(existing.map((account) => account.code));
    const roles = new Set(existing.map((account) => account.role));
    const template = chartOfAccountsTemplate(businessTypeFromIndustry(business.industryCode));
    // A code that is already used stays as it is. A role that already has an account is not given a second one.
    // Expense categories share the expense role on purpose, so a new expense code is still added.
    const missing = template.filter((account) => !codes.has(account.code) && (account.role === "expense" || !roles.has(account.role)));
    for (const account of missing) roles.add(account.role);

    const shops = await executor
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.businessId, businessId)))
      .orderBy(asc(branches.createdAt), asc(branches.id));
    const withCash = new Set(existing.filter((account) => account.role === "cash").map((account) => account.branchId));
    let nextCashNumber =
      existing
        .filter((account) => account.role === "cash")
        .map((account) => Number.parseInt(account.code.split("-")[1] ?? "0", 10))
        .reduce((max, value) => Math.max(max, value), 0) + 1;

    const roleFills = missingRoles(template, roles, codes);
    const rows = [
      ...missing.map((account) => ({ ...account, branchId: null as string | null })),
      ...roleFills.map((account) => ({ ...account, branchId: null as string | null })),
      ...shops
        .filter((shop) => !withCash.has(shop.id))
        .map((shop) => ({
          code: cashAccountCode(nextCashNumber++),
          name: cashAccountName(shop.name),
          type: "asset" as const,
          role: "cash" as const,
          branchId: shop.id as string | null,
        })),
    ];
    if (rows.length === 0) return 0;
    await executor.insert(ledgerAccounts).values(
      rows.map((row) => ({
        id: newId(),
        tenantId,
        businessId,
        branchId: row.branchId,
        code: row.code,
        name: row.name,
        accountType: row.type,
        role: row.role,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })),
    );
    return rows.length;
  }

  async list(tenantId: string, businessId: string) {
    await this.db.transaction((tx) => this.ensure(tx, tenantId, businessId));
    return this.db
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.businessId, businessId)))
      .orderBy(asc(ledgerAccounts.code));
  }
}

/**
 * A role the template needs and the business does not have yet. `service_income` prefers 4050, then 4051.
 * Any other taken code takes the next free number in the same thousand (4000, then 4001).
 * Existing accounts are never renamed or given a new role.
 */
function missingRoles(template: AccountTemplate[], roles: Set<string>, codes: Set<string>): AccountTemplate[] {
  const needed = template.filter((account) => account.role !== "expense" && !roles.has(account.role));
  needed.sort((a, b) => (a.role === "service_income" ? -1 : b.role === "service_income" ? 1 : a.code.localeCompare(b.code)));
  const added: AccountTemplate[] = [];
  for (const account of needed) {
    if (roles.has(account.role)) continue;
    const preferred = account.role === "service_income" ? { ...account, code: "4050", name: "Service income" } : account;
    const code = freeCode(preferred.code, codes);
    codes.add(code);
    roles.add(account.role);
    added.push({ ...preferred, code });
  }
  return added;
}

function freeCode(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  const match = /^(\d+)(.*)$/.exec(preferred);
  if (!match?.[1]) throw new ApiError("LEDGER_ACCOUNT_NOT_FOUND", booksCouldNotSave(null), 422);
  const start = Number(match[1]);
  const suffix = match[2] ?? "";
  const floor = Math.floor(start / 1000) * 1000;
  for (let next = start + 1; next <= floor + 999; next += 1) {
    const code = `${next}${suffix}`;
    if (!taken.has(code)) return code;
  }
  throw new ApiError("LEDGER_ACCOUNT_NOT_FOUND", booksCouldNotSave(null), 422);
}
