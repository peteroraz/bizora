import { Inject, Injectable } from "@nestjs/common";
import {
  quantityToString,
  ROLE_PERMISSIONS,
  Permission,
  parseCountQuantity,
  parseQuantity,
  stockAdjustSchema,
  stockCountSchema,
  stockReceiveSchema,
  supplierReturnSchema,
  stockTransferSchema,
  type DocumentType,
  stockCountApproveSchema,
  stockCountRejectSchema,
} from "@bizora/contracts";
import { averageUnitCost, issueStock, QUANTITY_SCALE } from "@bizora/money";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, memberships, products, shopDevices, stockBalances, stockCounts, stockMovements, stockRequests, stockTransferLines, stockTransfers, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { addPurchase, addSupplierReturn, findOrAddSupplier, owedNow } from "../suppliers/supplier-ledger.js";
import { LedgerPostingService, type PostingLine } from "../ledger/ledger-posting.service.js";
import {
  type BranchRow,
  type BusinessRow,
  findBranch,
  type ProductRow,
  productUnitsFor,
  requireBusiness,
  requireProduct,
  resolveBranch,
  unitFactor,
} from "./inventory-scope.js";

/** "1 bag", "2 bags", "1.5 kg": for messages to people. */
const unitWord = (unit: string, quantity: bigint) => (quantity === 1000n || ["kg", "g", "ml", "l", "dozen"].includes(unit) ? unit : `${unit}s`);

export type MovementType =
  | "opening"
  | "received"
  | "sold"
  | "returned"
  | "adjusted"
  | "counted"
  | "transfer_out"
  | "transfer_in"
  | "supplier_return"
  | "job_use"
  | "job_return";

export type MovementInput = {
  id?: string;
  /** Who the stock came from (ADR-029); saved with the movement, which cannot change afterwards. */
  supplierId?: string | null;
  type: MovementType;
  /** Signed thousandths of the base unit: positive in, negative out. */
  quantity: bigint;
  enteredQuantity: bigint;
  enteredUnit: string;
  reason?: string | null;
  note?: string | null;
  supplier?: string | null;
  paidFrom?: "cash" | "bank" | "credit" | null;
  /** Total cost for goods coming in. Without it, the current average (or the product's default cost) is used. */
  totalCostMinor?: bigint | null;
  /** Exact value to use (the value that left the other shop in a transfer). */
  valueMinor?: bigint;
  transferId?: string | null;
  countId?: string | null;
  /**
   * Stock never goes below zero by something done here and now: you cannot sell, remove or move 2 bags when 1 is on
   * the shelf (review, 19 Nov). Only what already happened elsewhere may take it below zero, and is flagged: sales
   * made on a phone with no network, sales typed in from a book or photo, and count corrections.
   */
  mayGoBelowZero?: boolean;
  documentType?: DocumentType | null;
  occurredAt?: Date;
};

type Context = { tenant: TenantContext; business: BusinessRow; branch: BranchRow; product: ProductRow };

const ROUND = (numerator: bigint, denominator: bigint) => {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const result = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -result : result;
};

/**
 * Every change to stock goes through applyMovement(): it locks the shop's balance row, values the movement at
 * weighted-average cost, posts the accounting entry, writes the immutable movement and updates the balance, all in
 * the caller's transaction (ADR-014). Nothing else writes stock_movements or stock_balances.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async applyMovement(tx: DbExecutor, context: Context, input: MovementInput) {
    const { tenant, business, branch, product } = context;
    if (!product.trackStock) throw new ApiError("STOCK_NOT_TRACKED", "Stock is not counted for this product.", 422);
    const id = input.id ?? newId();
    const occurredAt = input.occurredAt ?? new Date();

    await tx
      .insert(stockBalances)
      .values({ tenantId: tenant.tenantId, businessId: business.id, branchId: branch.id, productId: product.id })
      .onConflictDoNothing();
    await tx.execute(
      sql`SELECT 1 FROM stock_balances WHERE tenant_id = ${tenant.tenantId} AND branch_id = ${branch.id} AND product_id = ${product.id} FOR UPDATE`,
    );
    const [balance] = await tx
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, branch.id), eq(stockBalances.productId, product.id)))
      .limit(1);
    const position = { quantity: balance?.quantity ?? 0n, valueMinor: balance?.valueMinor ?? 0n };
    const fallbackUnitCost = averageUnitCost(position) ?? product.defaultCostMinor ?? 0n;

    let value: bigint;
    if (input.quantity > 0n) {
      value = input.valueMinor ?? input.totalCostMinor ?? ROUND(fallbackUnitCost * input.quantity, QUANTITY_SCALE);
    } else {
      value = input.valueMinor ?? -issueStock(position, -input.quantity, fallbackUnitCost).costMinor;
    }
    const next = { quantity: position.quantity + input.quantity, valueMinor: position.valueMinor + value };
    if (input.quantity < 0n && next.quantity < 0n && !input.mayGoBelowZero) {
      const have = position.quantity > 0n ? position.quantity : 0n;
      throw new ApiError(
        "NOT_ENOUGH_STOCK",
        `Not enough ${product.name} in ${branch.name}: ${quantityToString(have)} ${unitWord(product.baseUnit, have)} left, ${quantityToString(-input.quantity)} ${unitWord(product.baseUnit, -input.quantity)} needed. Record the stock that came in first, or count it.`,
        422,
        [{ field: "quantity", message: `Only ${quantityToString(have)} left.` }],
      );
    }

    const documentNumber = input.documentType
      ? (await this.numbers.next(tx, tenant.tenantId, business.id, input.documentType)).number
      : null;

    const lines = this.postingLines(input, value, branch.id);
    let journalEntryId: string | null = null;
    if (lines) {
      const posted = await this.ledger.post(
        tx,
        { tenantId: tenant.tenantId, userId: tenant.userId },
        {
          businessId: business.id,
          branchId: branch.id,
          entryDate: localDate(occurredAt, business.timezone),
          source: { type: "stock_movement", id },
          postingKey: `stock:${id}`,
          description: `${this.describe(input)}: ${product.name}`.slice(0, 240),
          lines,
        },
      );
      journalEntryId = posted.entryId;
    }

    await tx.insert(stockMovements).values({
      id,
      tenantId: tenant.tenantId,
      businessId: business.id,
      branchId: branch.id,
      productId: product.id,
      movementType: input.type,
      quantity: input.quantity,
      valueMinor: value,
      enteredQuantity: input.enteredQuantity,
      enteredUnit: input.enteredUnit,
      reason: input.reason ?? null,
      note: input.note ?? null,
      supplier: input.supplier ?? null,
      supplierId: input.supplierId ?? null,
      paidFrom: input.paidFrom ?? null,
      documentNumber,
      transferId: input.transferId ?? null,
      countId: input.countId ?? null,
      journalEntryId,
      occurredAt,
      createdBy: tenant.userId,
      membershipId: tenant.membershipId,
      deviceId: tenant.deviceId ?? null,
      actorType: tenant.actorType ?? "HUMAN",
    });

    const negative = next.quantity < 0n;
    await tx
      .update(stockBalances)
      .set({
        quantity: next.quantity,
        valueMinor: next.valueMinor,
        // Below zero after a sync is allowed, but flagged for the owner; never silently corrected.
        negativeSince: negative ? (balance?.negativeSince ?? new Date()) : null,
        lastMovementAt: occurredAt,
        updatedAt: new Date(),
      })
      .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, branch.id), eq(stockBalances.productId, product.id)));

    return { id, valueMinor: value, documentNumber, quantity: next.quantity, negative };
  }

  // Stock in ---------------------------------------------------------------------------------------------------

  async receive(tenant: TenantContext, raw: unknown) {
    const payload = stockReceiveSchema.parse(raw);
    if (payload.paidFrom !== "credit" && !tenant.permissions.includes(Permission.PURCHASES_MANAGE)) {
      throw new ApiError(
        "FORBIDDEN",
        "Only a manager can record paying the supplier. Record it as owed to the supplier.",
        403,
        [{ field: "paidFrom", message: "Choose 'Owed to supplier'." }],
      );
    }
    if (payload.id) {
      const existing = await this.findMovement(tenant, payload.id);
      if (existing) return existing;
    }
    if (this.needsApproval(tenant)) return this.db.transaction(async (tx) => ({ waiting: true, request: await this.ask(tx, tenant, "receive", payload) }));
    return this.db.transaction(async (tx) => this.presentResult(tenant, await this.receiveIn(tx, tenant, payload)));
  }

  /**
   * Stock in, inside a transaction the caller owns, so a whole supplier delivery saves together (ADR-018).
   * The caller has already checked who may pay the supplier.
   */
  async receiveIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof stockReceiveSchema.parse>, options: { occurredAt?: Date } = {}) {
    const context = await this.context(tx, tenant, payload.productId, payload.branchId);
    const units = (await productUnitsFor(tx, tenant.tenantId, [context.product.id])).get(context.product.id) ?? [];
    const entered = parseQuantity(payload.quantity) as bigint;
    const quantity = this.toBase(entered, unitFactor(context.product, units, payload.unit, "purchase"));
    // The supplier named or chosen; a new name is added to the suppliers (ADR-029). Bought on credit with no
    // supplier named: kept under "Supplier not named", so what is owed is never lost.
    const supplier = await findOrAddSupplier(tx, tenant, context.business.id, {
      supplierId: payload.supplierId,
      name: payload.supplier,
      unnamedWhenMissing: payload.paidFrom === "credit",
    });
    const result = await this.applyMovement(tx, context, {
      ...(payload.id ? { id: payload.id } : {}),
      type: "received",
      quantity,
      enteredQuantity: entered,
      enteredUnit: payload.unit,
      supplier: supplier && !supplier.unnamed ? supplier.name : (payload.supplier ?? null),
      supplierId: supplier?.id ?? null,
      note: payload.note ?? null,
      paidFrom: payload.paidFrom,
      totalCostMinor: payload.totalCostMinor ? BigInt(payload.totalCostMinor) : null,
      documentType: "stock_in",
      ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
    });
    if (supplier && payload.paidFrom === "credit" && result.valueMinor > 0n) {
      const [movement] = await tx
        .select({ journalEntryId: stockMovements.journalEntryId, occurredAt: stockMovements.occurredAt })
        .from(stockMovements)
        .where(and(eq(stockMovements.tenantId, tenant.tenantId), eq(stockMovements.id, result.id)))
        .limit(1);
      await addPurchase(tx, tenant, {
        businessId: context.business.id,
        branchId: context.branch.id,
        supplierId: supplier.id,
        stockMovementId: result.id,
        amountMinor: result.valueMinor,
        currencyCode: context.business.baseCurrencyCode,
        entryDate: localDate(movement?.occurredAt ?? new Date(), context.business.timezone),
        payBy: payload.payBy,
        journalEntryId: movement?.journalEntryId ?? null,
      });
    }
    await this.record(tx, tenant, "stock.received", result.id, context, { note: payload.note ?? null, supplier: payload.supplier ?? null });
    return result;
  }

  /**
   * Goods sent back to a supplier (ADR-030), at their average cost. The supplier settles by taking it off what is
   * owed to them (refused when that is less than the goods are worth) or by paying money back, which only a manager
   * may record. Only stock that is on the shelf can go back.
   */
  async returnToSupplier(tenant: TenantContext, raw: unknown) {
    const payload = supplierReturnSchema.parse(raw);
    if (payload.settle !== "owed" && !tenant.permissions.includes(Permission.PURCHASES_MANAGE)) {
      throw new ApiError("FORBIDDEN", "Only a manager can record money back from a supplier. Take it off what you owe them.", 403, [
        { field: "settle", message: "Choose 'Off what we owe'." },
      ]);
    }
    if (payload.id) {
      const [taken] = await this.db.select().from(stockMovements).where(eq(stockMovements.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.presentResult(tenant, { id: taken.id, valueMinor: taken.valueMinor, documentNumber: taken.documentNumber, quantity: 0n, negative: false });
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    if (this.needsApproval(tenant)) return this.db.transaction(async (tx) => ({ waiting: true, request: await this.ask(tx, tenant, "supplier_return", payload) }));
    return this.db.transaction(async (tx) => this.returnToSupplierIn(tx, tenant, payload));
  }

  /** Goods back to a supplier, inside the caller's transaction (an approved request, ADR-034). */
  async returnToSupplierIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof supplierReturnSchema.parse>) {
    {
      const context = await this.context(tx, tenant, payload.productId, payload.branchId);
      const supplier = await findOrAddSupplier(tx, tenant, context.business.id, { supplierId: payload.supplierId });
      if (!supplier) throw new ApiError("SUPPLIER_NOT_FOUND", "That supplier was not found.", 404);
      const units = (await productUnitsFor(tx, tenant.tenantId, [context.product.id])).get(context.product.id) ?? [];
      const entered = parseQuantity(payload.quantity) as bigint;
      const quantity = this.toBase(entered, unitFactor(context.product, units, payload.unit, "purchase"));
      const result = await this.applyMovement(tx, context, {
        ...(payload.id ? { id: payload.id } : {}),
        type: "supplier_return",
        quantity: -quantity,
        enteredQuantity: entered,
        enteredUnit: payload.unit,
        supplier: supplier.name,
        supplierId: supplier.id,
        note: payload.note ?? null,
        paidFrom: payload.settle === "owed" ? "credit" : payload.settle,
        documentType: "supplier_return",
      });
      if (result.negative) {
        throw new ApiError("NOT_ENOUGH_STOCK", "You do not have that much of this product here to send back.", 422, [{ field: "quantity", message: "More than you have." }]);
      }
      const value = -result.valueMinor;
      const today = localDate(new Date(), context.business.timezone);
      if (payload.settle === "owed") {
        const owed = await owedNow(tx, tenant.tenantId, supplier.id, today);
        if (value > owed) {
          throw new ApiError("MORE_THAN_OWED", `These goods are worth more than you owe ${supplier.name}. Record the money they pay back instead.`, 400, [
            { field: "settle", message: "More than you owe." },
          ]);
        }
        const [movement] = await tx
          .select({ journalEntryId: stockMovements.journalEntryId })
          .from(stockMovements)
          .where(and(eq(stockMovements.tenantId, tenant.tenantId), eq(stockMovements.id, result.id)))
          .limit(1);
        await addSupplierReturn(tx, tenant, {
          businessId: context.business.id,
          branchId: context.branch.id,
          supplierId: supplier.id,
          stockMovementId: result.id,
          amountMinor: value,
          currencyCode: context.business.baseCurrencyCode,
          entryDate: today,
          note: payload.note ?? null,
          journalEntryId: movement?.journalEntryId ?? null,
        });
      }
      await this.record(tx, tenant, "stock.returned_to_supplier", result.id, context, { note: payload.note ?? null, settle: payload.settle });
      return this.presentResult(tenant, result);
    }
  }

  // Remove or correct -------------------------------------------------------------------------------------------

  async adjust(tenant: TenantContext, raw: unknown) {
    const payload = stockAdjustSchema.parse(raw);
    if (this.needsApproval(tenant)) return this.db.transaction(async (tx) => ({ waiting: true, request: await this.ask(tx, tenant, "adjust", payload) }));
    return this.db.transaction(async (tx) => this.adjustIn(tx, tenant, payload));
  }

  /** Taking stock off or adding it by hand, inside the caller's transaction (a spoken or file list, ADR-033). */
  async adjustIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof stockAdjustSchema.parse>) {
    const context = await this.context(tx, tenant, payload.productId, payload.branchId);
    const units = (await productUnitsFor(tx, tenant.tenantId, [context.product.id])).get(context.product.id) ?? [];
    const entered = parseQuantity(payload.quantity) as bigint;
    const amount = this.toBase(entered, unitFactor(context.product, units, payload.unit));
    const result = await this.applyMovement(tx, context, {
      type: "adjusted",
      quantity: payload.direction === "remove" ? -amount : amount,
      enteredQuantity: entered,
      enteredUnit: payload.unit,
      reason: payload.reason,
      note: payload.note ?? null,
    });
    await this.record(tx, tenant, "stock.adjusted", result.id, context, { reason: payload.reason, note: payload.note, quantity: payload.quantity, unit: payload.unit, direction: payload.direction });
    return this.presentResult(tenant, result);
  }

  // Move to another shop ------------------------------------------------------------------------------------------

  async transfer(tenant: TenantContext, raw: unknown) {
    const payload = stockTransferSchema.parse(raw);
    if (this.needsApproval(tenant)) return this.db.transaction(async (tx) => ({ waiting: true, request: await this.ask(tx, tenant, "transfer", payload) }));
    return this.db.transaction(async (tx) => this.transferIn(tx, tenant, payload));
  }

  /** Moving stock to another shop, inside the caller's transaction (ADR-033). */
  async transferIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof stockTransferSchema.parse>) {
    const from = await this.context(tx, tenant, payload.productId, payload.fromBranchId);
    if (payload.toBranchId === from.branch.id) {
      throw new ApiError("SAME_SHOP", "Choose a different shop to move the stock to.", 422, [{ field: "toBranchId", message: "Choose another shop." }]);
    }
    const to = { ...from, branch: await findBranch(tx, tenant, from.business.id, payload.toBranchId) };
    if (to.branch.closedAt) throw new ApiError("SHOP_CLOSED", "That shop is closed. Choose another shop.", 409, [{ field: "toBranchId", message: "Choose an open shop." }]);
    const units = (await productUnitsFor(tx, tenant.tenantId, [from.product.id])).get(from.product.id) ?? [];
    const entered = parseQuantity(payload.quantity) as bigint;
    const amount = this.toBase(entered, unitFactor(from.product, units, payload.unit));
    const transferId = newId();
    const out = await this.applyMovement(tx, from, {
      type: "transfer_out",
      quantity: -amount,
      enteredQuantity: entered,
      enteredUnit: payload.unit,
      note: payload.note ?? null,
      transferId,
      documentType: "stock_transfer",
    });
    // The receiving shop takes over exactly the cost value that left, so total stock value is unchanged.
    const arrived = await this.applyMovement(tx, to, {
      type: "transfer_in",
      quantity: amount,
      enteredQuantity: entered,
      enteredUnit: payload.unit,
      note: payload.note ?? null,
      transferId,
      valueMinor: -out.valueMinor,
    });
    // The quick way (sent and received at once) is kept as a transfer too, so every transfer has one history (ADR-047).
    const now = new Date();
    await tx.insert(stockTransfers).values({
      id: transferId,
      tenantId: tenant.tenantId,
      businessId: from.business.id,
      fromBranchId: from.branch.id,
      toBranchId: to.branch.id,
      status: "received",
      documentNumber: out.documentNumber,
      note: payload.note ?? null,
      requestedBy: tenant.userId,
      requestedMembershipId: tenant.membershipId,
      requestedAt: now,
      approvedBy: tenant.userId,
      approvedAt: now,
      dispatchedBy: tenant.userId,
      dispatchedAt: now,
      receivedBy: tenant.userId,
      receivedAt: now,
    });
    await tx.insert(stockTransferLines).values({
      id: newId(),
      tenantId: tenant.tenantId,
      businessId: from.business.id,
      transferId,
      lineNo: 1,
      productId: from.product.id,
      quantity: amount,
      enteredQuantity: entered,
      enteredUnit: payload.unit,
      valueMinor: -out.valueMinor,
      receivedQuantity: amount,
      outMovementId: out.id,
      inMovementId: arrived.id,
    });
    await this.record(tx, tenant, "stock.transferred", out.id, from, { note: payload.note ?? null, toBranchId: payload.toBranchId, quantity: payload.quantity, unit: payload.unit });
    return this.presentResult(tenant, out);
  }

  /**
   * Moves every product on hand in one shop into another, at the value it holds, when the owner closes a shop
   * (ADR-032). Products below zero are refused before this is called. Returns how many products moved.
   */
  async moveAllStock(tx: DbExecutor, tenant: TenantContext, fromBranchId: string, toBranchId: string, note: string) {
    const rows = await tx
      .select({ productId: stockBalances.productId, quantity: stockBalances.quantity })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, fromBranchId), gt(stockBalances.quantity, 0n)));
    for (const row of rows) {
      const from = await this.context(tx, tenant, row.productId, fromBranchId, { anyBranchInScope: true });
      const to = { ...from, branch: await findBranch(tx, tenant, from.business.id, toBranchId) };
      const transferId = newId();
      const out = await this.applyMovement(tx, from, {
        type: "transfer_out",
        quantity: -row.quantity,
        enteredQuantity: row.quantity,
        enteredUnit: from.product.baseUnit,
        note,
        transferId,
        documentType: "stock_transfer",
      });
      await this.applyMovement(tx, to, {
        type: "transfer_in",
        quantity: row.quantity,
        enteredQuantity: row.quantity,
        enteredUnit: from.product.baseUnit,
        note,
        transferId,
        valueMinor: -out.valueMinor,
      });
      await this.record(tx, tenant, "stock.transferred", out.id, from, { note, toBranchId, quantity: row.quantity.toString(), unit: from.product.baseUnit, shopClosed: true });
    }
    return rows.length;
  }

  // Changes that wait for a manager or owner (ADR-034) ---------------------------------------------------------

  /** Anyone who cannot adjust stock themselves (the store keeper) has stock in, changes and moves approved first. */
  needsApproval(tenant: TenantContext) {
    return !tenant.permissions.includes(Permission.STOCK_ADJUST);
  }

  /**
   * Records a stock change as a request. Everything is checked now (the product, the shops, what is on the shelf),
   * so the person hears about a problem at once; it is checked again when a manager or owner approves it.
   */
  async ask(
    tx: DbExecutor,
    tenant: TenantContext,
    kind: "receive" | "adjust" | "transfer" | "supplier_return",
    payload:
      | ReturnType<typeof stockReceiveSchema.parse>
      | ReturnType<typeof stockAdjustSchema.parse>
      | ReturnType<typeof stockTransferSchema.parse>
      | ReturnType<typeof supplierReturnSchema.parse>,
  ) {
    const id = ("id" in payload && payload.id) || newId();
    const [existing] = await tx.select().from(stockRequests).where(eq(stockRequests.id, id)).limit(1);
    if (existing) {
      if (existing.tenantId !== tenant.tenantId) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
      return this.presentRequest(existing, null, null);
    }
    const shopId = "fromBranchId" in payload ? payload.fromBranchId : "branchId" in payload ? payload.branchId : undefined;
    const context = await this.context(tx, tenant, payload.productId, shopId);
    const units = (await productUnitsFor(tx, tenant.tenantId, [context.product.id])).get(context.product.id) ?? [];
    const entered = parseQuantity(payload.quantity) as bigint;
    const amount = this.toBase(entered, unitFactor(context.product, units, payload.unit));
    const what = `${payload.quantity} ${payload.unit} of ${context.product.name}`;
    let summary: string;
    let stored: Record<string, unknown>;
    if (kind === "transfer") {
      const move = payload as ReturnType<typeof stockTransferSchema.parse>;
      if (move.toBranchId === context.branch.id) throw new ApiError("SAME_SHOP", "Choose a different shop to move the stock to.", 422, [{ field: "toBranchId", message: "Choose another shop." }]);
      const to = await findBranch(tx, tenant, context.business.id, move.toBranchId);
      if (to.closedAt) throw new ApiError("SHOP_CLOSED", "That shop is closed. Choose another shop.", 409, [{ field: "toBranchId", message: "Choose an open shop." }]);
      await this.assertOnShelf(tx, context, amount);
      summary = `Move ${what} from ${context.branch.name} to ${to.name}`;
      stored = { ...move, fromBranchId: context.branch.id };
    } else if (kind === "supplier_return") {
      const back = payload as ReturnType<typeof supplierReturnSchema.parse>;
      const supplier = await findOrAddSupplier(tx, tenant, context.business.id, { supplierId: back.supplierId });
      if (!supplier) throw new ApiError("SUPPLIER_NOT_FOUND", "That supplier was not found.", 404);
      await this.assertOnShelf(tx, context, amount);
      summary = `Send ${what} back to ${supplier.name}, off what we owe${back.note ? `: ${back.note}` : ""}`;
      stored = { ...back, branchId: context.branch.id };
    } else if (kind === "adjust") {
      const change = payload as ReturnType<typeof stockAdjustSchema.parse>;
      if (change.direction === "remove") await this.assertOnShelf(tx, context, amount);
      summary = `${change.direction === "remove" ? "Take off" : "Add"} ${what} (${change.reason.replace("_", " ")}): ${change.note}`;
      stored = { ...change, branchId: context.branch.id };
    } else {
      const delivery = payload as ReturnType<typeof stockReceiveSchema.parse>;
      summary = `Receive ${what}${delivery.supplier ? ` from ${delivery.supplier}` : ""}${delivery.paidFrom === "credit" ? " (owed)" : ""}`;
      stored = { ...delivery, branchId: context.branch.id };
    }
    const [row] = await tx
      .insert(stockRequests)
      .values({
        id,
        tenantId: tenant.tenantId,
        businessId: context.business.id,
        branchId: context.branch.id,
        productId: context.product.id,
        kind,
        payload: stored,
        summary: summary.slice(0, 400),
        requestedBy: tenant.userId,
        requestedMembershipId: tenant.membershipId,
      })
      .returning();
    await this.record(tx, tenant, "stock.requested", id, context, { kind, summary });
    const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, tenant.userId)).limit(1);
    await this.notifications.notify(tx, tenant.tenantId, await this.approvers(tx, tenant.tenantId, context.business.id, context.branch.id), {
      kind: "stock.request",
      saleId: null,
      actorName: me?.name ?? null,
      data: { summary: summary.slice(0, 160) },
      except: tenant.membershipId,
    });
    return this.presentRequest(row as typeof stockRequests.$inferSelect, me?.name ?? null, context.branch.name);
  }

  /** Managers and owners who can approve stock changes in this shop. */
  async approvers(tx: DbExecutor, tenantId: string, businessId: string, branchId: string) {
    const roles = Object.entries(ROLE_PERMISSIONS)
      .filter(([, codes]) => codes.includes(Permission.STOCK_ADJUST))
      .map(([role]) => role);
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, "ACTIVE"),
          inArray(memberships.role, roles),
          or(isNull(memberships.businessId), eq(memberships.businessId, businessId)),
          or(isNull(memberships.branchId), eq(memberships.branchId, branchId)),
        ),
      );
    return rows.map((row) => row.id);
  }

  presentRequest(row: typeof stockRequests.$inferSelect, requestedByName: string | null, shopName: string | null, decidedByName: string | null = null) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      summary: row.summary,
      productId: row.productId,
      shop: shopName,
      requestedBy: requestedByName,
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: decidedByName,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
    };
  }

  private async assertOnShelf(tx: DbExecutor, context: Context, amount: bigint) {
    if (!context.product.trackStock) return;
    const [balance] = await tx
      .select({ quantity: stockBalances.quantity })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, context.tenant.tenantId), eq(stockBalances.branchId, context.branch.id), eq(stockBalances.productId, context.product.id)))
      .limit(1);
    const have = balance?.quantity ?? 0n;
    if (amount > have) {
      const left = have > 0n ? have : 0n;
      throw new ApiError("NOT_ENOUGH_STOCK", `Not enough ${context.product.name} in ${context.branch.name}: ${quantityToString(left)} ${context.product.baseUnit} left.`, 422, [
        { field: "quantity", message: `Only ${quantityToString(left)} left.` },
      ]);
    }
  }

  // Counts --------------------------------------------------------------------------------------------------------

  /** A count by someone who can adjust stock is applied at once; anyone else's count waits for approval. */
  async count(tenant: TenantContext, raw: unknown) {
    const payload = stockCountSchema.parse(raw);
    if (payload.id) {
      const [existing] = await this.db
        .select()
        .from(stockCounts)
        .where(and(eq(stockCounts.tenantId, tenant.tenantId), eq(stockCounts.id, payload.id)))
        .limit(1);
      if (existing) return this.presentCount(existing);
    }
    return this.db.transaction(async (tx) => this.countIn(tx, tenant, payload));
  }

  /** A count, inside the caller's transaction (ADR-033). Those who may adjust stock have it approved at once. */
  async countIn(tx: DbExecutor, tenant: TenantContext, payload: ReturnType<typeof stockCountSchema.parse>) {
    const context = await this.context(tx, tenant, payload.productId, payload.branchId);
    const units = (await productUnitsFor(tx, tenant.tenantId, [context.product.id])).get(context.product.id) ?? [];
    const counted = this.toBase(parseCountQuantity(payload.countedQuantity) as bigint, unitFactor(context.product, units, payload.unit));
    const [balance] = await tx
      .select({ quantity: stockBalances.quantity })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, tenant.tenantId),
          eq(stockBalances.branchId, context.branch.id),
          eq(stockBalances.productId, context.product.id),
        ),
      )
      .limit(1);
    const system = balance?.quantity ?? 0n;
    const id = payload.id ?? newId();
    await tx.insert(stockCounts).values({
      id,
      tenantId: tenant.tenantId,
      businessId: context.business.id,
      branchId: context.branch.id,
      productId: context.product.id,
      countedQuantity: counted,
      systemQuantity: system,
      difference: counted - system,
      note: payload.note ?? null,
      countedBy: tenant.userId,
      countedMembershipId: tenant.membershipId,
      deviceId: tenant.deviceId ?? null,
      countedAt: new Date(),
    });
    await this.record(tx, tenant, "stock.counted", id, context, { note: payload.note ?? null, countedQuantity: payload.countedQuantity, unit: payload.unit });
    if (tenant.permissions.includes(Permission.STOCK_ADJUST)) await this.decide(tx, tenant, id, "approved");
    const [row] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).limit(1);
    return this.presentCount(row as typeof stockCounts.$inferSelect);
  }

  async approveCount(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = stockCountApproveSchema.parse(raw ?? {});
    return this.db.transaction(async (tx) => this.presentCount(await this.decide(tx, tenant, id, "approved", note)));
  }

  /** Rejecting a count says why, so the person who counted can see it in the history (7f). */
  async rejectCount(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = stockCountRejectSchema.parse(raw ?? {});
    return this.db.transaction(async (tx) => this.presentCount(await this.decide(tx, tenant, id, "rejected", note)));
  }

  async pendingCounts(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const filters = [eq(stockCounts.tenantId, tenant.tenantId), eq(stockCounts.businessId, business.id), eq(stockCounts.status, "pending")];
    if (tenant.membershipBranchId) filters.push(eq(stockCounts.branchId, tenant.membershipBranchId));
    const rows = await this.db
      .select({ count: stockCounts, productName: products.name, baseUnit: products.baseUnit, branchName: branches.name, countedByName: users.displayName })
      .from(stockCounts)
      .innerJoin(products, and(eq(products.tenantId, stockCounts.tenantId), eq(products.id, stockCounts.productId)))
      .innerJoin(branches, and(eq(branches.tenantId, stockCounts.tenantId), eq(branches.id, stockCounts.branchId)))
      .leftJoin(users, eq(users.id, stockCounts.countedBy))
      .where(and(...filters))
      .orderBy(stockCounts.countedAt)
      .limit(100);
    return rows.map((row) => ({
      ...this.presentCount(row.count),
      productName: row.productName,
      baseUnit: row.baseUnit,
      branchName: row.branchName,
      countedByName: row.countedByName,
    }));
  }

  private async decide(tx: DbExecutor, tenant: TenantContext, id: string, decision: "approved" | "rejected", decisionNote?: string) {
    const [count] = await tx
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.tenantId, tenant.tenantId), eq(stockCounts.id, id)))
      .limit(1);
    if (!count || (tenant.membershipBranchId && count.branchId !== tenant.membershipBranchId)) {
      throw new ApiError("NOT_FOUND", "Count was not found.", 404);
    }
    if (count.status !== "pending") throw new ApiError("ALREADY_DECIDED", "This count has already been approved or rejected.", 409);
    let movementId: string | null = null;
    if (decision === "approved" && count.difference !== 0n) {
      const context = await this.context(tx, tenant, count.productId, count.branchId, { anyBranchInScope: true });
      const product = context.product;
      const movement = await this.applyMovement(tx, context, {
        type: "counted",
        // The difference found when counting is applied, even if sales happened since.
        mayGoBelowZero: true,
        quantity: count.difference,
        enteredQuantity: count.countedQuantity,
        enteredUnit: product.baseUnit,
        reason: count.difference < 0n ? "count_short" : "count_over",
        // What the counter said, and what the approver added.
        note: [count.note, decisionNote].filter((part): part is string => Boolean(part)).join(" · ").slice(0, 240) || null,
        countId: count.id,
      });
      movementId = movement.id;
    }
    await tx
      .update(stockCounts)
      .set({ status: decision, decidedBy: tenant.userId, decidedAt: new Date(), movementId, decisionNote: decisionNote ?? null })
      .where(eq(stockCounts.id, count.id));
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action: decision === "approved" ? "stock.count_approved" : "stock.count_rejected",
        entityType: "product",
        entityId: count.productId,
        correlationId: tenant.correlationId,
        businessId: count.businessId,
        branchId: count.branchId,
        metadata: {
          movementOrCountId: count.id,
          note: decisionNote ?? null,
          countNote: count.note,
          countedQuantity: count.countedQuantity.toString(),
          systemQuantity: count.systemQuantity.toString(),
          difference: count.difference.toString(),
        },
        actorType: tenant.actorType ?? "HUMAN",
      },
      tx,
    );
    const [updated] = await tx.select().from(stockCounts).where(eq(stockCounts.id, count.id)).limit(1);
    return updated as typeof stockCounts.$inferSelect;
  }

  // Reading ---------------------------------------------------------------------------------------------------------

  async movements(tenant: TenantContext, productId: string, branchId?: string) {
    const business = await requireBusiness(this.db, tenant);
    await requireProduct(this.db, tenant, business.id, productId, { includeArchived: true });
    const filters = [eq(stockMovements.tenantId, tenant.tenantId), eq(stockMovements.productId, productId)];
    const scopedBranch = tenant.membershipBranchId ?? branchId;
    if (scopedBranch) filters.push(eq(stockMovements.branchId, scopedBranch));
    const rows = await this.db
      .select({ movement: stockMovements, branchName: branches.name, byName: users.displayName, deviceName: shopDevices.name })
      .from(stockMovements)
      .innerJoin(branches, and(eq(branches.tenantId, stockMovements.tenantId), eq(branches.id, stockMovements.branchId)))
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .leftJoin(shopDevices, and(eq(shopDevices.tenantId, stockMovements.tenantId), eq(shopDevices.id, stockMovements.deviceId)))
      .where(and(...filters))
      .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
      .limit(50);
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return rows.map(({ movement, branchName, byName, deviceName }) => ({
      id: movement.id,
      type: movement.movementType,
      quantity: movement.quantity.toString(),
      enteredQuantity: movement.enteredQuantity.toString(),
      enteredUnit: movement.enteredUnit,
      reason: movement.reason,
      note: movement.note,
      supplier: movement.supplier,
      paidFrom: movement.paidFrom,
      documentNumber: movement.documentNumber,
      occurredAt: movement.occurredAt,
      createdAt: movement.createdAt,
      branchName,
      byName,
      deviceName,
      actorType: movement.actorType,
      ...(seeCost ? { valueMinor: movement.valueMinor.toString() } : {}),
    }));
  }

  /** Products at or below their low-stock level in this shop. */
  async lowStock(tenant: TenantContext, branchId?: string) {
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, branchId);
    const onHand = sql<string>`coalesce(${stockBalances.quantity}, 0)`;
    const rows = await this.db
      .select({ id: products.id, name: products.name, baseUnit: products.baseUnit, lowStockLevel: products.lowStockLevel, quantity: onHand })
      .from(products)
      .leftJoin(
        stockBalances,
        and(eq(stockBalances.tenantId, products.tenantId), eq(stockBalances.productId, products.id), eq(stockBalances.branchId, branch.id)),
      )
      .where(
        and(
          eq(products.tenantId, tenant.tenantId),
          eq(products.businessId, business.id),
          isNull(products.archivedAt),
          eq(products.trackStock, true),
          isNotNull(products.lowStockLevel),
          lte(onHand, products.lowStockLevel),
        ),
      )
      .orderBy(onHand, products.name)
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUnit: row.baseUnit,
      quantity: BigInt(row.quantity).toString(),
      lowStockLevel: row.lowStockLevel?.toString() ?? null,
    }));
  }

  /** Shops stock can be moved to: every shop of the business, names only. */
  async shops(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    return this.db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, tenant.tenantId), eq(branches.businessId, business.id), isNull(branches.closedAt)))
      .orderBy(branches.name);
  }

  /** Products below zero after a sync, for the owner to check (never corrected automatically). */
  async belowZero(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const filters = [eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.businessId, business.id), isNotNull(stockBalances.negativeSince)];
    if (tenant.membershipBranchId) filters.push(eq(stockBalances.branchId, tenant.membershipBranchId));
    const rows = await this.db
      .select({ productId: stockBalances.productId, name: products.name, baseUnit: products.baseUnit, branchName: branches.name, quantity: stockBalances.quantity, since: stockBalances.negativeSince })
      .from(stockBalances)
      .innerJoin(products, and(eq(products.tenantId, stockBalances.tenantId), eq(products.id, stockBalances.productId)))
      .innerJoin(branches, and(eq(branches.tenantId, stockBalances.tenantId), eq(branches.id, stockBalances.branchId)))
      .where(and(...filters))
      .orderBy(stockBalances.negativeSince)
      .limit(50);
    return rows.map((row) => ({ ...row, quantity: row.quantity.toString() }));
  }

  // Helpers ---------------------------------------------------------------------------------------------------------

  async context(
    tx: DbExecutor,
    tenant: TenantContext,
    productId: string,
    branchId?: string,
    options: { anyBranchInScope?: boolean } = {},
  ): Promise<Context> {
    const business = await requireBusiness(tx, tenant);
    const branch =
      options.anyBranchInScope && branchId
        ? await findBranch(tx, tenant, business.id, branchId)
        : await resolveBranch(tx, tenant, business.id, branchId);
    const product = await requireProduct(tx, tenant, business.id, productId);
    return { tenant, business, branch, product };
  }

  private toBase(entered: bigint, factor: bigint) {
    const quantity = (entered * factor + 500n) / 1000n;
    if (quantity <= 0n) throw new ApiError("VALIDATION_ERROR", "Enter a larger quantity.", 400, [{ field: "quantity", message: "Too small." }]);
    return quantity;
  }

  private async findMovement(tenant: TenantContext, id: string) {
    const [existing] = await this.db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.id, id))
      .limit(1);
    if (!existing) return null;
    if (existing.tenantId !== tenant.tenantId) {
      throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const [balance] = await this.db
      .select({ quantity: stockBalances.quantity })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, tenant.tenantId), eq(stockBalances.branchId, existing.branchId), eq(stockBalances.productId, existing.productId)))
      .limit(1);
    return this.presentResult(tenant, {
      id: existing.id,
      valueMinor: existing.valueMinor,
      documentNumber: existing.documentNumber,
      quantity: balance?.quantity ?? 0n,
      negative: (balance?.quantity ?? 0n) < 0n,
    });
  }

  private postingLines(input: MovementInput, value: bigint, branchId: string): PostingLine[] | null {
    if (value === 0n || input.type === "transfer_in" || input.type === "transfer_out") return null;
    const amount = value < 0n ? -value : value;
    const stock = { account: { role: "stock" as const } };
    // Goods sold leave stock at cost; the sale's own entry records the money and the revenue.
    if (input.type === "sold") {
      return [
        { account: { role: "cogs" }, debitMinor: amount },
        { ...stock, creditMinor: amount },
      ];
    }
    // Parts used on a job wait in "Jobs in progress" until the job is billed; a removed line brings them back (ADR-035).
    if (input.type === "job_use") {
      return [
        { account: { role: "jobs_in_progress" }, debitMinor: amount },
        { ...stock, creditMinor: amount },
      ];
    }
    if (input.type === "job_return") {
      return [
        { ...stock, debitMinor: amount },
        { account: { role: "jobs_in_progress" }, creditMinor: amount },
      ];
    }
    // Goods back from a cancelled sale return at the cost they left with.
    if (input.type === "returned" && (input.reason === "sale_void" || input.reason === "customer_return")) {
      return [
        { ...stock, debitMinor: amount },
        { account: { role: "cogs" }, creditMinor: amount },
      ];
    }
    // Goods sent back to a supplier (ADR-030): off what is owed to them, or money back to the drawer or the bank.
    if (input.type === "supplier_return") {
      const debit: PostingLine["account"] =
        input.paidFrom === "cash" ? { role: "cash", branchId } : input.paidFrom === "bank" ? { role: "bank" } : { role: "payable" };
      return [
        { account: debit, debitMinor: amount, ...(input.supplier ? { memo: input.supplier.slice(0, 240) } : {}) },
        { ...stock, creditMinor: amount },
      ];
    }
    if (input.type === "opening") {
      return [
        { ...stock, debitMinor: amount },
        { account: { role: "capital" }, creditMinor: amount, memo: "Opening stock" },
      ];
    }
    if (input.type === "received" || input.type === "returned") {
      const credit: PostingLine["account"] =
        input.paidFrom === "cash" ? { role: "cash", branchId } : input.paidFrom === "bank" ? { role: "bank" } : { role: "payable" };
      return [
        { ...stock, debitMinor: amount, ...(input.supplier ? { memo: input.supplier.slice(0, 240) } : {}) },
        { account: credit, creditMinor: amount },
      ];
    }
    // Adjusted or counted.
    if (value > 0n) {
      return [
        { ...stock, debitMinor: amount },
        { account: { role: "stock_loss" }, creditMinor: amount, memo: input.reason ?? undefined },
      ];
    }
    const debit: PostingLine["account"] =
      input.reason === "own_use" ? { role: "drawings" } : input.reason === "gift" ? { code: "6900" } : { role: "stock_loss" };
    return [
      { account: debit, debitMinor: amount, ...(input.reason ? { memo: input.reason } : {}) },
      { ...stock, creditMinor: amount },
    ];
  }

  private describe(input: MovementInput) {
    switch (input.type) {
      case "opening":
        return "Opening stock";
      case "received":
        return "Stock received";
      case "sold":
        return "Sold";
      case "returned":
        return input.reason === "customer_return" ? "Returned by a customer" : "Returned from a cancelled sale";
      case "supplier_return":
        return "Sent back to the supplier";
      case "job_use":
        return "Used on a job";
      case "job_return":
        return "Back from a job";
      case "counted":
        return "Stock count difference";
      case "adjusted":
        return input.quantity < 0n ? `Stock removed (${input.reason ?? "other"})` : `Stock added (${input.reason ?? "correction"})`;
      default:
        return "Stock movement";
    }
  }

  private presentResult(tenant: TenantContext, result: { id: string; valueMinor: bigint; documentNumber: string | null; quantity: bigint; negative: boolean }) {
    return {
      movementId: result.id,
      documentNumber: result.documentNumber,
      onHand: result.quantity.toString(),
      belowZero: result.negative,
      ...(tenant.permissions.includes(Permission.PRICES_COST_READ) ? { valueMinor: result.valueMinor.toString() } : {}),
    };
  }

  private presentCount(count: typeof stockCounts.$inferSelect) {
    return {
      id: count.id,
      productId: count.productId,
      branchId: count.branchId,
      countedQuantity: count.countedQuantity.toString(),
      systemQuantity: count.systemQuantity.toString(),
      difference: count.difference.toString(),
      status: count.status,
      note: count.note,
      decisionNote: count.decisionNote,
      countedAt: count.countedAt,
      decidedAt: count.decidedAt,
    };
  }

  /** Every stock action in the audit trail carries what was said about it (7f). */
  private async record(tx: DbExecutor, tenant: TenantContext, action: string, entityId: string, context: Context, details: Record<string, unknown> = {}) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "product",
        entityId: context.product.id,
        correlationId: tenant.correlationId,
        businessId: context.business.id,
        branchId: context.branch.id,
        metadata: { movementOrCountId: entityId, ...details },
        actorType: tenant.actorType ?? "HUMAN",
      },
      tx,
    );
  }
}

