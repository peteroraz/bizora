import { Inject, Injectable } from "@nestjs/common";
import { closeShopSchema, defaultShopSchema, Permission } from "@bizora/contracts";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, businesses, customers, journalEntries, journalLines, ledgerAccounts, memberships, sales, sessions, shopDevices, stockBalances, stockCounts } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { StockService } from "../inventory/stock.service.js";
import { LedgerPostingService } from "../ledger/ledger-posting.service.js";

/**
 * Shops (ADR-032): only the owner closes a shop, and may move what is left in it (stock, cash in the drawer, staff and
 * their default shop, customers) into another shop of the same business. A closed shop keeps its history.
 * Everyone's default shop is kept here too.
 */
@Injectable()
export class ShopService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** What closing a shop would involve, so the owner sees it before confirming. */
  async closingCheck(tenant: TenantContext, branchId: string) {
    this.assertOwner(tenant);
    return this.db.transaction(async (tx) => {
      const branch = await this.openBranch(tx, tenant, branchId);
      return { shop: { id: branch.id, name: branch.name }, ...(await this.whatIsLeft(tx, tenant.tenantId, branch.businessId, branch.id)) };
    });
  }

  async close(tenant: TenantContext, branchId: string, raw: unknown) {
    this.assertOwner(tenant);
    const payload = closeShopSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const branch = await this.openBranch(tx, tenant, branchId, true);
      const [business] = await tx.select().from(businesses).where(and(eq(businesses.tenantId, tenant.tenantId), eq(businesses.id, branch.businessId))).limit(1);
      if (!business) throw new ApiError("NOT_FOUND", "Shop not found.", 404);
      const others = await tx
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, branch.businessId), ne(branches.id, branch.id), isNull(branches.closedAt)));
      if (others.length === 0) throw new ApiError("LAST_SHOP", "This is the business's only open shop, so it cannot be closed.", 409);
      const target = payload.moveToBranchId ? others.find((shop) => shop.id === payload.moveToBranchId) : undefined;
      if (payload.moveToBranchId && !target) {
        throw new ApiError("VALIDATION_ERROR", "Choose another open shop of this business.", 400, [{ field: "moveToBranchId", message: "Choose an open shop." }]);
      }

      const left = await this.whatIsLeft(tx, tenant.tenantId, branch.businessId, branch.id);
      if (left.openSales > 0) {
        throw new ApiError("SHOP_HAS_OPEN_SALES", `${left.openSales} sale(s) in this shop are still waiting at the cashier or for goods to be given out. Finish or cancel them first.`, 409);
      }
      if (left.belowZero > 0) {
        throw new ApiError("SHOP_BELOW_ZERO", `${left.belowZero} product(s) in this shop show less than zero. Count them first.`, 409);
      }
      const somethingLeft = left.productsInStock > 0 || left.cashMinor !== "0" || left.staff > 0 || left.customers > 0;
      if (somethingLeft && !target) {
        throw new ApiError("CHOOSE_SHOP", "This shop still has stock, cash, staff or customers. Choose the shop to move them to.", 400, [
          { field: "moveToBranchId", message: "Choose a shop." },
        ]);
      }

      const now = new Date();
      const today = localDate(now, business.timezone);
      const note = `${branch.name} closed: ${payload.reason}`.slice(0, 240);
      let movedProducts = 0;
      if (target) {
        // Stock, at the value it holds.
        movedProducts = await this.stock.moveAllStock(tx, tenant, branch.id, target.id, note);
        // The cash in the drawer goes with it.
        const cash = BigInt(left.cashMinor);
        if (cash !== 0n) {
          await this.ledger.post(
            tx,
            { tenantId: tenant.tenantId, userId: tenant.userId },
            {
              businessId: business.id,
              branchId: target.id,
              entryDate: today,
              source: { type: "shop_closed", id: branch.id },
              postingKey: `shop_closed:${branch.id}`,
              description: `Cash moved from ${branch.name} to ${target.name} when the shop closed`,
              lines:
                cash > 0n
                  ? [
                      { account: { role: "cash", branchId: target.id }, debitMinor: cash },
                      { account: { role: "cash", branchId: branch.id }, creditMinor: cash },
                    ]
                  : [
                      { account: { role: "cash", branchId: branch.id }, debitMinor: -cash },
                      { account: { role: "cash", branchId: target.id }, creditMinor: -cash },
                    ],
            },
          );
        }
        // Staff who worked only there now work in the other shop; they sign in again.
        const moved = await tx
          .update(memberships)
          .set({ branchId: target.id, updatedAt: now })
          .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.branchId, branch.id)))
          .returning({ id: memberships.id });
        if (moved.length > 0) {
          await tx
            .update(sessions)
            .set({ revokedAt: now })
            .where(and(inArray(sessions.membershipId, moved.map((row) => row.id)), isNull(sessions.revokedAt)));
        }
        await tx.update(memberships).set({ defaultBranchId: target.id }).where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.defaultBranchId, branch.id)));
        await tx.update(customers).set({ branchId: target.id }).where(and(eq(customers.tenantId, tenant.tenantId), eq(customers.branchId, branch.id)));
      } else {
        await tx.update(memberships).set({ defaultBranchId: null }).where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.defaultBranchId, branch.id)));
      }

      // Shop phones there stop working, and counts waiting there are closed.
      const devices = await tx
        .update(shopDevices)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(shopDevices.tenantId, tenant.tenantId), eq(shopDevices.branchId, branch.id), isNull(shopDevices.revokedAt)))
        .returning({ id: shopDevices.id });
      if (devices.length > 0) {
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(inArray(sessions.deviceId, devices.map((row) => row.id)), isNull(sessions.revokedAt)));
      }
      await tx
        .update(stockCounts)
        .set({ status: "rejected", decidedBy: tenant.userId, decidedAt: now, decisionNote: note })
        .where(and(eq(stockCounts.tenantId, tenant.tenantId), eq(stockCounts.branchId, branch.id), eq(stockCounts.status, "pending")));

      await tx
        .update(branches)
        .set({ closedAt: now, closedBy: tenant.userId, closedReason: payload.reason, movedIntoBranchId: target?.id ?? null, updatedAt: now })
        .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, branch.id)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "branch.closed",
          entityType: "branch",
          entityId: branch.id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          branchId: branch.id,
          metadata: {
            name: branch.name,
            reason: payload.reason,
            movedInto: target ? { id: target.id, name: target.name } : null,
            movedProducts,
            movedCashMinor: target ? left.cashMinor : "0",
            movedStaff: target ? left.staff : 0,
            movedCustomers: target ? left.customers : 0,
            devicesStopped: devices.length,
          },
        },
        tx,
      );
      return {
        shop: { id: branch.id, name: branch.name, closedAt: now.toISOString() },
        movedInto: target ?? null,
        moved: { products: movedProducts, cashMinor: target ? left.cashMinor : "0", staff: target ? left.staff : 0, customers: target ? left.customers : 0 },
        devicesStopped: devices.length,
      };
    });
  }

  /**
   * Sets the shop someone's Bizora opens in. People set their own; those who manage users set anyone's. Someone tied
   * to one shop always opens there.
   */
  async setDefaultShop(tenant: TenantContext, membershipId: string, raw: unknown) {
    const { branchId } = defaultShopSchema.parse(raw);
    const self = membershipId === tenant.membershipId;
    if (!self && !tenant.permissions.includes(Permission.USERS_MANAGE)) throw new ApiError("FORBIDDEN", "Only an owner or administrator can set another person's shop.", 403);
    const [member] = await this.db.select().from(memberships).where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.id, membershipId))).limit(1);
    if (!member) throw new ApiError("NOT_FOUND", "Person not found.", 404);
    if (branchId) {
      const [branch] = await this.db.select().from(branches).where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, branchId))).limit(1);
      if (!branch || branch.closedAt) throw new ApiError("VALIDATION_ERROR", "Choose an open shop.", 400, [{ field: "branchId", message: "Choose an open shop." }]);
      if (member.businessId && branch.businessId !== member.businessId) throw new ApiError("VALIDATION_ERROR", "That shop is in another business.", 400, [{ field: "branchId", message: "Choose a shop they can work in." }]);
      if (member.branchId && member.branchId !== branchId) {
        throw new ApiError("VALIDATION_ERROR", "This person works in one shop only; that is always the shop Bizora opens in.", 400, [{ field: "branchId", message: "Tied to one shop." }]);
      }
    }
    await this.db.update(memberships).set({ defaultBranchId: branchId, updatedAt: new Date() }).where(eq(memberships.id, member.id));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "membership.default_shop_set",
      entityType: "membership",
      entityId: member.id,
      correlationId: tenant.correlationId,
      metadata: { branchId },
    });
    return { membershipId: member.id, defaultBranchId: branchId };
  }

  private assertOwner(tenant: TenantContext) {
    // Closing a shop moves stock, cash and staff: the business owner alone decides it.
    if (tenant.role !== "OWNER" || tenant.deviceId) throw new ApiError("FORBIDDEN", "Only the owner can close a shop.", 403);
  }

  private async openBranch(tx: DbExecutor, tenant: TenantContext, branchId: string, lock = false) {
    const query = tx.select().from(branches).where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.id, branchId))).limit(1);
    const [branch] = lock ? await query.for("update") : await query;
    if (!branch || (tenant.membershipBusinessId && branch.businessId !== tenant.membershipBusinessId)) throw new ApiError("NOT_FOUND", "Shop not found.", 404);
    if (branch.closedAt) throw new ApiError("ALREADY_CLOSED", "This shop is already closed.", 409);
    return branch;
  }

  /** Stock, cash, people and unfinished sales still in a shop. */
  private async whatIsLeft(tx: DbExecutor, tenantId: string, businessId: string, branchId: string) {
    const count = sql<number>`count(*)::int`;
    const [[stockRow], [belowRow], [cashRow], [staffRow], [customerRow], [salesRow]] = await Promise.all([
      tx.select({ n: count }).from(stockBalances).where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.branchId, branchId), sql`${stockBalances.quantity} > 0`)),
      tx.select({ n: count }).from(stockBalances).where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.branchId, branchId), lt(stockBalances.quantity, 0n))),
      tx
        .select({ balance: sql<string>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)::text` })
        .from(journalLines)
        .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.tenantId, journalLines.tenantId), eq(ledgerAccounts.id, journalLines.accountId)))
        .innerJoin(journalEntries, and(eq(journalEntries.tenantId, journalLines.tenantId), eq(journalEntries.id, journalLines.entryId)))
        .where(and(eq(journalLines.tenantId, tenantId), eq(ledgerAccounts.businessId, businessId), eq(ledgerAccounts.role, "cash"), eq(ledgerAccounts.branchId, branchId))),
      tx.select({ n: count }).from(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.branchId, branchId), eq(memberships.status, "ACTIVE"))),
      tx.select({ n: count }).from(customers).where(and(eq(customers.tenantId, tenantId), eq(customers.branchId, branchId))),
      tx
        .select({ n: count })
        .from(sales)
        .where(and(eq(sales.tenantId, tenantId), eq(sales.branchId, branchId), or(eq(sales.status, "awaiting_payment"), eq(sales.status, "awaiting_release")))),
    ]);
    return {
      productsInStock: stockRow?.n ?? 0,
      belowZero: belowRow?.n ?? 0,
      cashMinor: cashRow?.balance ?? "0",
      staff: staffRow?.n ?? 0,
      customers: customerRow?.n ?? 0,
      openSales: salesRow?.n ?? 0,
    };
  }
}
