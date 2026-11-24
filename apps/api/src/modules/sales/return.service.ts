import { Inject, Injectable } from "@nestjs/common";
import { parseQuantity, Permission, saleReturnSchema } from "@bizora/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { products, saleLines, saleReturnLines, saleReturns, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { findBranch, requireBusiness } from "../inventory/inventory-scope.js";
import { ChartOfAccountsService } from "../ledger/chart-of-accounts.service.js";
import { StockService } from "../inventory/stock.service.js";
import { SerialService } from "../inventory/serial.service.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";

type SaleLine = typeof saleLines.$inferSelect;

/**
 * What a sale line is worth after its share of the whole-sale discount: the money that came in for it, so a return
 * gives back no more than was paid for the goods.
 */
export function lineNetMinor(line: Pick<SaleLine, "lineTotalMinor">, sale: { subtotalMinor: bigint; discountMinor: bigint }) {
  if (sale.discountMinor === 0n || sale.subtotalMinor === 0n) return line.lineTotalMinor;
  return line.lineTotalMinor - (sale.discountMinor * line.lineTotalMinor) / sale.subtotalMinor;
}

/**
 * Goods a customer brings back (ADR-030). One entry per return: Dr "Returns from customers" for what the goods were
 * worth, Cr what the customer still owed on the sale (taken off first), Cr the drawer or the bank for the rest. Goods
 * that can be sold again go back on the shelf at the cost they left with (Dr stock Cr cost of goods sold); broken or
 * expired goods stay out, so their cost remains a cost.
 */
@Injectable()
export class ReturnService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChartOfAccountsService) private readonly chart: ChartOfAccountsService,
    @Inject(SerialService) private readonly serials: SerialService,
  ) {}

  async returnGoods(tenant: TenantContext, saleId: string, raw: unknown) {
    const payload = saleReturnSchema.parse(raw);
    if (payload.id) {
      const [taken] = await this.db.select({ tenantId: saleReturns.tenantId, saleId: saleReturns.saleId }).from(saleReturns).where(eq(saleReturns.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId && taken.saleId === saleId) return { returnId: payload.id };
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      // Businesses set up before returns existed get "Returns from customers" (4150) on their first return.
      await this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId);
      const [sale] = await tx
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.tenantId, tenant.tenantId),
            eq(sales.businessId, business.id),
            eq(sales.id, saleId),
            ...(tenant.membershipBranchId ? [eq(sales.branchId, tenant.membershipBranchId)] : []),
          ),
        )
        .for("update")
        .limit(1);
      if (!sale) throw new ApiError("NOT_FOUND", "Sale not found.", 404);
      if (sale.status !== "completed") {
        throw new ApiError(
          "NOT_RETURNABLE",
          sale.status === "voided" ? "This sale was cancelled." : "Goods can come back once the sale is finished and the goods were given out.",
          409,
        );
      }
      if (sale.historyOnly) throw new ApiError("NOT_RETURNABLE", "This sale was brought in as history; record the return as a new sale.", 409);
      // The business's returns rule (ADR-059): later than that, only the owner (or an administrator) accepts goods back.
      if (business.returnsWithinDays) {
        const soldDay = localDate(sale.soldAt, business.timezone);
        const today = localDate(new Date(), business.timezone);
        const daysAgo = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${soldDay}T00:00:00Z`)) / 86_400_000);
        if (daysAgo > business.returnsWithinDays && !tenant.permissions.includes(Permission.TENANT_MANAGE)) {
          throw new ApiError(
            "RETURN_TOO_LATE",
            `This sale was ${daysAgo} days ago, and goods are taken back within ${business.returnsWithinDays} days. Ask the owner to accept this return.`,
            403,
          );
        }
      }

      const lines = await tx.select().from(saleLines).where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.saleId, sale.id)));
      const byId = new Map(lines.map((line) => [line.id, line]));
      const already = await this.returnedSoFar(tx, tenant.tenantId, lines.map((line) => line.id));
      const branch = await findBranch(tx, tenant, business.id, sale.branchId);

      const planned: {
        line: SaleLine;
        quantity: bigint;
        entered: bigint;
        amount: bigint;
        cost: bigint;
        backToStock: boolean;
        wholeLine: boolean;
        serials?: string[];
      }[] = [];
      const seen = new Set<string>();
      for (const requested of payload.lines) {
        const line = byId.get(requested.saleLineId);
        if (!line) throw new ApiError("VALIDATION_ERROR", "That item is not on this sale.", 400, [{ field: "lines", message: "Not on this sale." }]);
        if (seen.has(line.id)) throw new ApiError("VALIDATION_ERROR", "Each item once per return.", 400);
        seen.add(line.id);
        const entered = parseQuantity(requested.quantity) as bigint;
        const before = already.get(line.id) ?? { quantity: 0n, entered: 0n, amount: 0n, cost: 0n };
        const enteredLeft = line.enteredQuantity - before.entered;
        if (entered > enteredLeft) {
          throw new ApiError("TOO_MANY", `Only ${enteredLeft / 1000n}${enteredLeft % 1000n ? `.${(enteredLeft % 1000n).toString().padStart(3, "0").replace(/0+$/, "")}` : ""} of "${line.description}" can still come back.`, 400, [
            { field: "lines", message: "More than was sold." },
          ]);
        }
        const last = entered === enteredLeft;
        // The last of a line takes whatever is left, so rounding never leaves or loses a kobo.
        const quantity = last ? line.quantity - before.quantity : (line.quantity * entered) / line.enteredQuantity;
        const net = lineNetMinor(line, sale);
        const amount = last ? net - before.amount : (net * entered) / line.enteredQuantity;
        const lineCost = line.costMinor ?? 0n;
        const cost = last ? lineCost - before.cost : (lineCost * entered) / line.enteredQuantity;
        planned.push({ line, quantity, entered, amount, cost, backToStock: requested.backToStock, wholeLine: last, ...(requested.serials ? { serials: requested.serials } : {}) });
      }

      const total = planned.reduce((sum, item) => sum + item.amount, 0n);
      const offBalance = total < sale.balanceMinor ? total : sale.balanceMinor;
      const refund = total - offBalance;
      const today = localDate(new Date(), business.timezone);
      const number = (await this.numbers.next(tx, tenant.tenantId, business.id, "sale_return")).number;

      let journalEntryId: string | null = null;
      if (total > 0n) {
        const posting: PostingLine[] = [{ account: { role: "sales_returns" }, debitMinor: total, memo: sale.saleNumber ?? sale.invoiceNumber ?? undefined }];
        if (offBalance > 0n) posting.push({ account: { role: "debtors" }, creditMinor: offBalance, memo: "Off what was owed" });
        if (refund > 0n) {
          posting.push({
            account: payload.refundMethod === "cash" ? { role: "cash", branchId: branch.id } : { role: "bank" },
            creditMinor: refund,
            memo: payload.refundMethod,
          });
        }
        const posted = await this.ledger.post(
          tx,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          {
            businessId: business.id,
            branchId: branch.id,
            entryDate: today,
            source: { type: "sale_return", id },
            postingKey: `sale-return:${id}`,
            description: `Return ${number} from sale ${sale.saleNumber ?? sale.invoiceNumber}: ${payload.reason}`.slice(0, 240),
            lines: posting,
          },
        );
        journalEntryId = posted.entryId;
      }

      await tx.insert(saleReturns).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        saleId: sale.id,
        customerId: sale.customerId,
        returnNumber: number,
        totalMinor: total,
        offBalanceMinor: offBalance,
        refundMinor: refund,
        refundMethod: refund > 0n ? payload.refundMethod : null,
        currencyCode: business.baseCurrencyCode,
        reason: payload.reason,
        journalEntryId,
        createdBy: tenant.userId,
        membershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
      });

      const productIds = planned.map((item) => item.line.productId).filter((value): value is string => Boolean(value));
      const productRows = productIds.length
        ? await tx.select().from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, productIds)))
        : [];
      const productById = new Map(productRows.map((row) => [row.id, row]));
      for (const item of planned) {
        let movementId: string | null = null;
        const product = item.line.productId ? productById.get(item.line.productId) : undefined;
        // Only goods that left stock go back to it.
        if (item.backToStock && product && item.line.stockMovementId) {
          const movement = await this.stock.applyMovement(tx, { tenant, business, branch, product: { ...product, trackStock: true } }, {
            type: "returned",
            quantity: item.quantity,
            enteredQuantity: item.entered,
            enteredUnit: item.line.enteredUnit,
            reason: "customer_return",
            note: number,
            valueMinor: item.cost,
          });
          movementId = movement.id;
        }
        await tx.insert(saleReturnLines).values({
          id: newId(),
          tenantId: tenant.tenantId,
          returnId: id,
          saleLineId: item.line.id,
          quantity: item.quantity,
          enteredQuantity: item.entered,
          enteredUnit: item.line.enteredUnit,
          amountMinor: item.amount,
          costMinor: item.cost,
          backToStock: movementId !== null,
          stockMovementId: movementId,
        });
        // The units that came back, for a product with serial numbers (ADR-062).
        await this.serials.returned(tx, tenant, {
          saleId: sale.id,
          saleLineId: item.line.id,
          ...(item.serials ? { serials: item.serials } : {}),
          wholeLine: item.wholeLine,
          backToStock: movementId !== null,
          returnNumber: number,
        });
      }

      await tx
        .update(sales)
        .set({
          returnedMinor: sql`${sales.returnedMinor} + ${total}`,
          returnedOffBalanceMinor: sql`${sales.returnedOffBalanceMinor} + ${offBalance}`,
          balanceMinor: sql`${sales.balanceMinor} - ${offBalance}`,
        })
        .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, sale.id)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "sale.returned",
          entityType: "sale",
          entityId: sale.id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          branchId: branch.id,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: {
            returnId: id,
            number,
            totalMinor: total.toString(),
            offBalanceMinor: offBalance.toString(),
            refundMinor: refund.toString(),
            refundMethod: payload.refundMethod,
            reason: payload.reason,
          },
        },
        tx,
      );
    });
    return { returnId: id };
  }

  /** The returns of a sale with their lines, and how much of each sale line has come back (in the unit sold). */
  async forSale(executor: DbExecutor, tenantId: string, saleId: string, lineIds: string[]) {
    const [returns, sums] = await Promise.all([
      executor
        .select({ ret: saleReturns, by: users.displayName })
        .from(saleReturns)
        .leftJoin(users, eq(users.id, saleReturns.createdBy))
        .where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.saleId, saleId)))
        .orderBy(asc(saleReturns.createdAt)),
      this.returnedSoFar(executor, tenantId, lineIds),
    ]);
    const lines = returns.length
      ? await executor
          .select()
          .from(saleReturnLines)
          .where(and(eq(saleReturnLines.tenantId, tenantId), inArray(saleReturnLines.returnId, returns.map(({ ret }) => ret.id))))
      : [];
    return {
      returnedByLine: new Map([...sums.entries()].map(([lineId, sum]) => [lineId, sum.entered])),
      returns: returns.map(({ ret, by }) => ({
        id: ret.id,
        number: ret.returnNumber,
        totalMinor: ret.totalMinor.toString(),
        offBalanceMinor: ret.offBalanceMinor.toString(),
        refundMinor: ret.refundMinor.toString(),
        refundMethod: ret.refundMethod,
        reason: ret.reason,
        byName: by,
        createdAt: ret.createdAt.toISOString(),
        lines: lines
          .filter((line) => line.returnId === ret.id)
          .map((line) => ({
            saleLineId: line.saleLineId,
            enteredQuantity: line.enteredQuantity.toString(),
            enteredUnit: line.enteredUnit,
            amountMinor: line.amountMinor.toString(),
            backToStock: line.backToStock,
          })),
      })),
    };
  }

  private async returnedSoFar(executor: DbExecutor, tenantId: string, lineIds: string[]) {
    const map = new Map<string, { quantity: bigint; entered: bigint; amount: bigint; cost: bigint }>();
    if (lineIds.length === 0) return map;
    const rows = await executor
      .select({
        lineId: saleReturnLines.saleLineId,
        quantity: sql<string>`sum(${saleReturnLines.quantity})::text`,
        entered: sql<string>`sum(${saleReturnLines.enteredQuantity})::text`,
        amount: sql<string>`sum(${saleReturnLines.amountMinor})::text`,
        cost: sql<string>`sum(${saleReturnLines.costMinor})::text`,
      })
      .from(saleReturnLines)
      .where(and(eq(saleReturnLines.tenantId, tenantId), inArray(saleReturnLines.saleLineId, lineIds)))
      .groupBy(saleReturnLines.saleLineId);
    for (const row of rows) {
      map.set(row.lineId, { quantity: BigInt(row.quantity), entered: BigInt(row.entered), amount: BigInt(row.amount), cost: BigInt(row.cost) });
    }
    return map;
  }
}
