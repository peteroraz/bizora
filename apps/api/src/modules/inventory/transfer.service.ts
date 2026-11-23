import { Inject, Injectable } from "@nestjs/common";
import {
  Permission,
  parseCountQuantity,
  parseQuantity,
  quantityToString,
  transferCancelSchema,
  transferCreateSchema,
  transferDecisionSchema,
  transferReceiveSchema,
} from "@bizora/contracts";
import { and, asc, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, products, stockTransferLines, stockTransfers } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { DocumentNumberService } from "../documents/document-number.service.js";
import { findBranch, productUnitsFor, requireBusiness, requireProduct, resolveBranch, unitFactor } from "./inventory-scope.js";
import { StockService } from "./stock.service.js";

type TransferRow = typeof stockTransfers.$inferSelect;
type LineRow = typeof stockTransferLines.$inferSelect;
const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, message: string) => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) throw new ApiError("VALIDATION_ERROR", message, 400, result.error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "form", message: issue.message })));
  return result.data;
};

/**
 * Transfers between shops and warehouses (ADR-047): requested, approved, dispatched, received or cancelled.
 *
 * - Dispatching writes a `transfer_out` movement at the sender for each line: the stock and its cost value leave the
 *   sender and are in transit, in neither place's balance.
 * - Receiving writes a `transfer_in` at the receiver with exactly the value that left. The receiver's stock never rises
 *   before then. Less arriving than was sent is recorded as missing at the receiver, at the value that was sent.
 * - Transfers post nothing to the books: the stock stays in the Stock account the whole time. A shortfall posts a stock
 *   loss through the usual removal (ADR-014).
 */
@Injectable()
export class TransferService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(DocumentNumberService) private readonly numbers: DocumentNumberService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, query: { status?: string }) {
    const business = await requireBusiness(this.db, tenant);
    const filters: SQL[] = [eq(stockTransfers.tenantId, tenant.tenantId), eq(stockTransfers.businessId, business.id)];
    if (tenant.membershipBranchId) {
      const own = or(eq(stockTransfers.fromBranchId, tenant.membershipBranchId), eq(stockTransfers.toBranchId, tenant.membershipBranchId));
      if (own) filters.push(own);
    }
    if (query.status && ["requested", "approved", "dispatched", "received", "cancelled"].includes(query.status)) filters.push(eq(stockTransfers.status, query.status as "requested"));
    const rows = await this.db.select().from(stockTransfers).where(and(...filters)).orderBy(desc(stockTransfers.requestedAt)).limit(100);
    return this.present(tenant, rows);
  }

  async get(tenant: TenantContext, id: string) {
    const transfer = await this.find(this.db, tenant, id);
    return (await this.present(tenant, [transfer]))[0];
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = parse(transferCreateSchema, raw, "Check the transfer.");
    if (payload.id) {
      const [taken] = await this.db.select().from(stockTransfers).where(eq(stockTransfers.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const id = payload.id ?? newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      if (payload.fromBranchId) this.assertAt(tenant, payload.fromBranchId, "send");
      const from = await resolveBranch(tx, tenant, business.id, payload.fromBranchId);
      if (payload.toBranchId === from.id) throw new ApiError("SAME_SHOP", "Choose a different place to send the stock to.", 422, [{ field: "toBranchId", message: "Choose another." }]);
      const to = await findBranch(tx, tenant, business.id, payload.toBranchId);
      if (to.closedAt) throw new ApiError("SHOP_CLOSED", "That shop is closed. Choose another one.", 409, [{ field: "toBranchId", message: "Choose an open one." }]);
      const seen = new Set<string>();
      const lines: (typeof stockTransferLines.$inferInsert)[] = [];
      for (const [index, line] of payload.lines.entries()) {
        if (seen.has(line.productId)) throw new ApiError("VALIDATION_ERROR", "Each product can be on a transfer once. Add the quantities together.", 400, [{ field: `lines.${index}.productId`, message: "Repeated." }]);
        seen.add(line.productId);
        const product = await requireProduct(tx, tenant, business.id, line.productId);
        if (!product.trackStock) throw new ApiError("STOCK_NOT_TRACKED", `Stock is not counted for ${product.name}.`, 422, [{ field: `lines.${index}.productId`, message: "Not counted." }]);
        const units = (await productUnitsFor(tx, tenant.tenantId, [product.id])).get(product.id) ?? [];
        const entered = parseQuantity(line.quantity) as bigint;
        const quantity = (entered * unitFactor(product, units, line.unit) + 500n) / 1000n;
        if (quantity <= 0n) throw new ApiError("VALIDATION_ERROR", "Enter a larger quantity.", 400, [{ field: `lines.${index}.quantity`, message: "Too small." }]);
        lines.push({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, transferId: id, lineNo: index + 1, productId: product.id, quantity, enteredQuantity: entered, enteredUnit: line.unit });
      }
      // Staff who cannot adjust stock ask first (ADR-034); everyone else's transfer is approved when made.
      const needsApproval = !tenant.permissions.includes(Permission.STOCK_ADJUST);
      const now = new Date();
      const number = (await this.numbers.next(tx, tenant.tenantId, business.id, "stock_transfer")).number;
      await tx.insert(stockTransfers).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        fromBranchId: from.id,
        toBranchId: to.id,
        status: needsApproval ? "requested" : "approved",
        documentNumber: number,
        note: payload.note ?? null,
        requestedBy: tenant.userId,
        requestedMembershipId: tenant.membershipId,
        requestedAt: now,
        ...(needsApproval ? {} : { approvedBy: tenant.userId, approvedAt: now }),
      });
      await tx.insert(stockTransferLines).values(lines);
      await this.record(tx, tenant, business.id, from.id, "stock.transfer_requested", id, { number, toBranchId: to.id, lines: lines.length, needsApproval });
      if (payload.dispatchNow && !needsApproval) await this.dispatchIn(tx, tenant, id);
    });
    return this.get(tenant, id);
  }

  async approve(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = parse(transferDecisionSchema, raw, "Check the note.");
    await this.db.transaction(async (tx) => {
      const transfer = await this.find(tx, tenant, id, { lock: true });
      if (transfer.status !== "requested") throw new ApiError("TRANSFER_NOT_WAITING", "This transfer is not waiting for approval.", 409);
      this.assertAt(tenant, transfer.fromBranchId, "send");
      await tx.update(stockTransfers).set({ status: "approved", approvedBy: tenant.userId, approvedAt: new Date(), updatedAt: new Date() }).where(eq(stockTransfers.id, id));
      await this.record(tx, tenant, transfer.businessId, transfer.fromBranchId, "stock.transfer_approved", id, { note: note ?? null });
    });
    return this.get(tenant, id);
  }

  async dispatch(tenant: TenantContext, id: string) {
    await this.db.transaction(async (tx) => this.dispatchIn(tx, tenant, id));
    return this.get(tenant, id);
  }

  private async dispatchIn(tx: DbExecutor, tenant: TenantContext, id: string) {
    const transfer = await this.find(tx, tenant, id, { lock: true });
    if (transfer.status !== "approved") {
      throw new ApiError("TRANSFER_NOT_READY", transfer.status === "requested" ? "This transfer needs approval before it is sent." : "This transfer has already been sent or closed.", 409);
    }
    this.assertAt(tenant, transfer.fromBranchId, "send");
    const lines = await this.lines(tx, tenant.tenantId, [id]);
    for (const line of lines) {
      // The sender's own stock rules apply: you cannot send more than is on the shelf.
      const context = await this.stock.context(tx, tenant, line.productId, transfer.fromBranchId, { anyBranchInScope: true });
      if (context.branch.closedAt) throw new ApiError("SHOP_CLOSED", `${context.branch.name} is closed, so it cannot send stock.`, 409);
      const out = await this.stock.applyMovement(tx, context, {
        type: "transfer_out",
        quantity: -line.quantity,
        enteredQuantity: line.enteredQuantity,
        enteredUnit: line.enteredUnit,
        note: transfer.note,
        transferId: id,
      });
      await tx.update(stockTransferLines).set({ valueMinor: -out.valueMinor, outMovementId: out.id }).where(eq(stockTransferLines.id, line.id));
    }
    await tx.update(stockTransfers).set({ status: "dispatched", dispatchedBy: tenant.userId, dispatchedAt: new Date(), updatedAt: new Date() }).where(eq(stockTransfers.id, id));
    await this.record(tx, tenant, transfer.businessId, transfer.fromBranchId, "stock.transfer_dispatched", id, { number: transfer.documentNumber });
  }

  async receive(tenant: TenantContext, id: string, raw: unknown) {
    const payload = parse(transferReceiveSchema, raw, "Check what arrived.");
    await this.db.transaction(async (tx) => {
      const transfer = await this.find(tx, tenant, id, { lock: true });
      if (transfer.status !== "dispatched") {
        throw new ApiError("TRANSFER_NOT_IN_TRANSIT", transfer.status === "received" ? "This transfer has already been received." : "This transfer has not been sent yet.", 409);
      }
      this.assertAt(tenant, transfer.toBranchId, "receive");
      const lines = await this.lines(tx, tenant.tenantId, [id]);
      const given = new Map((payload.lines ?? []).map((line) => [line.lineId, parseCountQuantity(line.receivedQuantity) as bigint]));
      for (const lineId of given.keys()) {
        if (!lines.some((line) => line.id === lineId)) throw new ApiError("VALIDATION_ERROR", "A line is not on this transfer.", 400, [{ field: "lines", message: lineId }]);
      }
      let missingLines = 0;
      for (const line of lines) {
        // Received quantities are typed in the unit the line was sent in.
        const product = await requireProduct(tx, tenant, transfer.businessId, line.productId);
        const units = (await productUnitsFor(tx, tenant.tenantId, [product.id])).get(product.id) ?? [];
        const enteredReceived = given.get(line.id);
        const received = enteredReceived === undefined ? line.quantity : (enteredReceived * unitFactor(product, units, line.enteredUnit) + 500n) / 1000n;
        if (received > line.quantity) {
          throw new ApiError("TOO_MANY_RECEIVED", `More ${product.name} arrived than was sent. Receive what was sent, and record the rest as stock in.`, 422, [{ field: "lines", message: line.id }]);
        }
        const context = await this.stock.context(tx, tenant, line.productId, transfer.toBranchId, { anyBranchInScope: true });
        if (context.branch.closedAt) throw new ApiError("SHOP_CLOSED", `${context.branch.name} is closed. Ask the owner to send the stock somewhere open.`, 409);
        const value = line.valueMinor ?? 0n;
        // Everything sent arrives in the books first, at the value that left; anything missing is then taken off.
        const arrived = await this.stock.applyMovement(tx, context, {
          type: "transfer_in",
          quantity: line.quantity,
          enteredQuantity: line.enteredQuantity,
          enteredUnit: line.enteredUnit,
          note: payload.note ?? transfer.note,
          transferId: id,
          valueMinor: value,
        });
        let shortId: string | null = null;
        if (received < line.quantity) {
          missingLines += 1;
          const short = line.quantity - received;
          const shortValue = (value * short + line.quantity / 2n) / line.quantity;
          const missing = await this.stock.applyMovement(tx, context, {
            type: "adjusted",
            quantity: -short,
            enteredQuantity: short,
            enteredUnit: product.baseUnit,
            reason: "missing",
            note: `Missing on transfer ${transfer.documentNumber ?? ""}: ${quantityToString(short)} ${product.baseUnit}`.trim().slice(0, 240),
            transferId: id,
            valueMinor: -shortValue,
            mayGoBelowZero: true,
          });
          shortId = missing.id;
        }
        await tx.update(stockTransferLines).set({ receivedQuantity: received, inMovementId: arrived.id, shortMovementId: shortId }).where(eq(stockTransferLines.id, line.id));
      }
      await tx
        .update(stockTransfers)
        .set({ status: "received", receivedBy: tenant.userId, receivedAt: new Date(), receiveNote: payload.note ?? null, updatedAt: new Date() })
        .where(eq(stockTransfers.id, id));
      await this.record(tx, tenant, transfer.businessId, transfer.toBranchId, "stock.transfer_received", id, { number: transfer.documentNumber, missingLines, note: payload.note ?? null });
    });
    return this.get(tenant, id);
  }

  /** Only before it is sent. Once stock has left, receive it (all, some or none) so the books follow what happened. */
  async cancel(tenant: TenantContext, id: string, raw: unknown) {
    const { reason } = parse(transferCancelSchema, raw, "Say why the transfer is cancelled.");
    await this.db.transaction(async (tx) => {
      const transfer = await this.find(tx, tenant, id, { lock: true });
      if (transfer.status !== "requested" && transfer.status !== "approved") {
        throw new ApiError(
          "TRANSFER_CANNOT_CANCEL",
          transfer.status === "dispatched" ? "The stock has already left. Receive it, and record anything that did not arrive as missing." : "This transfer is already closed.",
          409,
        );
      }
      // The person who asked may withdraw it; anyone else needs to be able to adjust stock.
      if (transfer.requestedBy !== tenant.userId && !tenant.permissions.includes(Permission.STOCK_ADJUST)) {
        throw new ApiError("FORBIDDEN", "Only the person who asked, or a manager, can cancel this transfer.", 403);
      }
      await tx.update(stockTransfers).set({ status: "cancelled", cancelledBy: tenant.userId, cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(stockTransfers.id, id));
      await this.record(tx, tenant, transfer.businessId, transfer.fromBranchId, "stock.transfer_cancelled", id, { reason });
    });
    return this.get(tenant, id);
  }

  /**
   * Staff kept to one shop act only at their own: they send from it and receive into it. Everyone else acts anywhere
   * in the business. (resolveBranch would quietly use the person's own shop instead, so this is checked first.)
   */
  private assertAt(tenant: TenantContext, branchId: string, what: "send" | "receive") {
    if (tenant.membershipBranchId && tenant.membershipBranchId !== branchId) {
      throw new ApiError("TRANSFER_NOT_FOUND", what === "send" ? "Only the place sending this transfer can do that." : "Only the place receiving this transfer can receive it.", 404);
    }
  }

  /** Stock on its way to (incoming) or from (outgoing) each place, for one product (ADR-047). */
  async inTransit(executor: DbExecutor, tenantId: string, productId: string) {
    const rows = await executor
      .select({ from: stockTransfers.fromBranchId, to: stockTransfers.toBranchId, quantity: stockTransferLines.quantity })
      .from(stockTransferLines)
      .innerJoin(stockTransfers, and(eq(stockTransfers.tenantId, stockTransferLines.tenantId), eq(stockTransfers.id, stockTransferLines.transferId)))
      .where(and(eq(stockTransferLines.tenantId, tenantId), eq(stockTransferLines.productId, productId), eq(stockTransfers.status, "dispatched")));
    const map = new Map<string, { incoming: bigint; outgoing: bigint }>();
    for (const row of rows) {
      const to = map.get(row.to) ?? { incoming: 0n, outgoing: 0n };
      to.incoming += row.quantity;
      map.set(row.to, to);
      const from = map.get(row.from) ?? { incoming: 0n, outgoing: 0n };
      from.outgoing += row.quantity;
      map.set(row.from, from);
    }
    return map;
  }

  private async find(executor: DbExecutor, tenant: TenantContext, id: string, options: { lock?: boolean } = {}) {
    const business = await requireBusiness(executor, tenant);
    const query = executor
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, tenant.tenantId), eq(stockTransfers.businessId, business.id), eq(stockTransfers.id, id)))
      .limit(1);
    const [transfer] = options.lock ? await query.for("update") : await query;
    // Staff kept to one shop see only transfers that leave or reach it.
    if (!transfer || (tenant.membershipBranchId && transfer.fromBranchId !== tenant.membershipBranchId && transfer.toBranchId !== tenant.membershipBranchId)) {
      throw new ApiError("TRANSFER_NOT_FOUND", "This transfer was not found.", 404);
    }
    return transfer;
  }

  private async lines(executor: DbExecutor, tenantId: string, ids: string[]) {
    if (ids.length === 0) return [] as LineRow[];
    return executor.select().from(stockTransferLines).where(and(eq(stockTransferLines.tenantId, tenantId), inArray(stockTransferLines.transferId, ids))).orderBy(asc(stockTransferLines.lineNo));
  }

  private async present(tenant: TenantContext, rows: TransferRow[]) {
    const lines = await this.lines(this.db, tenant.tenantId, rows.map((row) => row.id));
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const names = productIds.length
      ? await this.db.select({ id: products.id, name: products.name, baseUnit: products.baseUnit }).from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, productIds)))
      : [];
    const branchIds = [...new Set(rows.flatMap((row) => [row.fromBranchId, row.toBranchId]))];
    const places = branchIds.length ? await this.db.select({ id: branches.id, name: branches.name, kind: branches.kind }).from(branches).where(and(eq(branches.tenantId, tenant.tenantId), inArray(branches.id, branchIds))) : [];
    const seeCost = tenant.permissions.includes(Permission.PRICES_COST_READ);
    return rows.map((row) => ({
      id: row.id,
      number: row.documentNumber,
      status: row.status,
      from: places.find((place) => place.id === row.fromBranchId) ?? { id: row.fromBranchId, name: "", kind: "shop" },
      to: places.find((place) => place.id === row.toBranchId) ?? { id: row.toBranchId, name: "", kind: "shop" },
      note: row.note,
      requestedAt: row.requestedAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      receiveNote: row.receiveNote,
      mine: row.requestedBy === tenant.userId,
      lines: lines
        .filter((line) => line.transferId === row.id)
        .map((line) => {
          const product = names.find((item) => item.id === line.productId);
          return {
            id: line.id,
            productId: line.productId,
            productName: product?.name ?? "",
            baseUnit: product?.baseUnit ?? line.enteredUnit,
            quantity: line.quantity.toString(),
            enteredQuantity: line.enteredQuantity.toString(),
            enteredUnit: line.enteredUnit,
            receivedQuantity: line.receivedQuantity?.toString() ?? null,
            ...(seeCost ? { valueMinor: line.valueMinor?.toString() ?? null } : {}),
          };
        }),
    }));
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, branchId: string, action: string, id: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType: "stock_transfer", entityId: id, correlationId: tenant.correlationId, businessId, branchId, actorType: tenant.actorType ?? "HUMAN", metadata },
      tx,
    );
  }
}
