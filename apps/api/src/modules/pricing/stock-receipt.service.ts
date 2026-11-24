import { Inject, Injectable } from "@nestjs/common";
import { spreadByWeight, stockReceiptCreateSchema, stockReceiveSchema } from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase } from "../../db/database.js";
import { stockMovements, stockReceipts } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { requireBusiness, resolveBranch } from "../inventory/inventory-scope.js";
import { StockService } from "../inventory/stock.service.js";
import { findOrAddSupplier } from "../suppliers/supplier-ledger.js";

type Charge = { paidFrom: "cash" | "bank"; amountMinor: bigint };

/**
 * A delivery of several products with its charges (ADR-048). Each charge (transport, clearing, loading, customs,
 * freight) is spread over the products by the value of their goods, in whole kobo that add up exactly, and becomes
 * part of their stock value, so the average cost and profit include it. The supplier is owed (or paid) for the goods
 * only; the charges are paid from the drawer or the bank. Everything saves together or not at all.
 */
@Injectable()
export class StockReceiptService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  async create(tenant: TenantContext, raw: unknown) {
    const payload = stockReceiptCreateSchema.parse(raw);
    const id = payload.id ?? newId();
    if (payload.id) {
      const [taken] = await this.db.select().from(stockReceipts).where(eq(stockReceipts.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const seen = new Set<string>();
    payload.lines.forEach((line, index) => {
      if (seen.has(line.productId)) {
        throw new ApiError("VALIDATION_ERROR", "A product is on the delivery twice. Put it on one line.", 400, [{ field: `lines.${index}.productId`, message: "Already on the delivery." }]);
      }
      seen.add(line.productId);
    });
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const branch = await resolveBranch(tx, tenant, business.id, payload.branchId);
      const supplier = await findOrAddSupplier(tx, tenant, business.id, {
        supplierId: payload.supplierId,
        name: payload.supplier,
        unnamedWhenMissing: payload.paidFrom === "credit",
      });
      const goods = payload.lines.map((line) => BigInt(line.totalCostMinor));
      const goodsTotal = goods.reduce((sum, value) => sum + value, 0n);
      // Each charge spread by the goods' value; a line gets its share of each, so the books show where each went.
      const perLine: Charge[][] = payload.lines.map(() => []);
      for (const charge of payload.charges) {
        const shares = spreadByWeight(BigInt(charge.amountMinor), goods);
        shares.forEach((share, index) => {
          if (share > 0n) perLine[index]?.push({ paidFrom: charge.paidFrom, amountMinor: share });
        });
      }
      const chargesTotal = payload.charges.reduce((sum, charge) => sum + BigInt(charge.amountMinor), 0n);
      await tx.insert(stockReceipts).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        branchId: branch.id,
        supplierId: supplier?.id ?? null,
        goodsMinor: goodsTotal,
        chargesMinor: chargesTotal,
        charges: payload.charges.map((charge) => ({ kind: charge.kind, amountMinor: charge.amountMinor, paidFrom: charge.paidFrom })),
        note: payload.note ?? null,
        createdBy: tenant.userId,
      });
      let firstNumber: string | null = null;
      for (const [index, line] of payload.lines.entries()) {
        const result = await this.stock.receiveIn(
          tx,
          tenant,
          stockReceiveSchema.parse({
            productId: line.productId,
            branchId: branch.id,
            quantity: line.quantity,
            unit: line.unit,
            totalCostMinor: line.totalCostMinor,
            paidFrom: payload.paidFrom,
            ...(line.serials?.length ? { serials: line.serials } : {}),
            ...(supplier ? { supplierId: supplier.id } : {}),
            ...(payload.payBy ? { payBy: payload.payBy } : {}),
            ...(payload.note ? { note: payload.note } : {}),
          }),
          { charges: perLine[index] ?? [], receiptId: id },
        ).catch((error: unknown) => {
          // Say which line, so the person can fix it.
          if (error instanceof ApiError) throw new ApiError(error.code, error.message, error.getStatus(), [{ field: `lines.${index}.productId`, message: error.message }]);
          throw error;
        });
        firstNumber ??= result.documentNumber;
      }
      await tx.update(stockReceipts).set({ documentNumber: firstNumber }).where(and(eq(stockReceipts.tenantId, tenant.tenantId), eq(stockReceipts.id, id)));
    });
    return this.get(tenant, id);
  }

  async get(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const [receipt] = await this.db
      .select()
      .from(stockReceipts)
      .where(and(eq(stockReceipts.tenantId, tenant.tenantId), eq(stockReceipts.businessId, business.id), eq(stockReceipts.id, id)))
      .limit(1);
    if (!receipt) throw new ApiError("NOT_FOUND", "That delivery was not found.", 404);
    const lines = await this.db
      .select({
        movementId: stockMovements.id,
        productId: stockMovements.productId,
        enteredQuantity: stockMovements.enteredQuantity,
        enteredUnit: stockMovements.enteredUnit,
        valueMinor: stockMovements.valueMinor,
        chargesMinor: stockMovements.chargesMinor,
        documentNumber: stockMovements.documentNumber,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, tenant.tenantId), eq(stockMovements.receiptId, receipt.id)));
    return {
      id: receipt.id,
      documentNumber: receipt.documentNumber,
      supplierId: receipt.supplierId,
      goodsMinor: receipt.goodsMinor.toString(),
      chargesMinor: receipt.chargesMinor.toString(),
      charges: receipt.charges,
      createdAt: receipt.createdAt,
      lines: lines.map((line) => ({
        movementId: line.movementId,
        productId: line.productId,
        valueMinor: line.valueMinor.toString(),
        chargesMinor: line.chargesMinor.toString(),
        goodsMinor: (line.valueMinor - line.chargesMinor).toString(),
        documentNumber: line.documentNumber,
      })),
    };
  }
}
