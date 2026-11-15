import { Inject, Injectable } from "@nestjs/common";
import { businessTypeFromIndustry, cashAccountCode, cashAccountName, chartOfAccountsTemplate } from "@bizora/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
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
    // Lock the business so two requests cannot create the same accounts at once.
    await executor.execute(sql`SELECT id FROM businesses WHERE tenant_id = ${tenantId} AND id = ${businessId} FOR UPDATE`);
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
    const missing = chartOfAccountsTemplate(businessTypeFromIndustry(business.industryCode)).filter(
      (account) => !codes.has(account.code),
    );

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

    const rows = [
      ...missing.map((account) => ({ ...account, branchId: null as string | null })),
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
