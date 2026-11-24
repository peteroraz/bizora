import { Inject, Injectable } from "@nestjs/common";
import {
  Permission,
  countSessionCreateSchema,
  countSessionDecisionSchema,
  countSessionLineSchema,
  countSessionRejectSchema,
  parseCountQuantity,
} from "@bizora/contracts";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, products, stockCountSessionLines, stockCountSessions } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { balanceAt, countTime, productUnitsFor, requireBusiness, requireProduct, resolveBranch, unitFactor } from "./inventory-scope.js";
import { StockService } from "./stock.service.js";

type SessionRow = typeof stockCountSessions.$inferSelect;
const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, message: string) => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) throw new ApiError("VALIDATION_ERROR", message, 400, result.error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "form", message: issue.message })));
  return result.data;
};

/**
 * Count sessions (ADR-047): many products counted in one place, then submitted, approved and posted together.
 *
 * - Each line keeps what the system expected when the product was counted, what was counted, and the difference.
 * - Posting applies each difference as a `counted` movement, even if sales happened in between: the difference found
 *   when counting is what is corrected, exactly as single counts work (ADR-014). Nothing already recorded changes.
 * - Counting needs `stock.count`. Approving and posting needs `stock.adjust` (managers and owners).
 */
@Injectable()
export class CountSessionService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const filters: SQL[] = [eq(stockCountSessions.tenantId, tenant.tenantId), eq(stockCountSessions.businessId, business.id)];
    if (tenant.membershipBranchId) filters.push(eq(stockCountSessions.branchId, tenant.membershipBranchId));
    const rows = await this.db.select().from(stockCountSessions).where(and(...filters)).orderBy(desc(stockCountSessions.createdAt)).limit(100);
    return this.present(tenant, rows, false);
  }

  async get(tenant: TenantContext, id: string) {
    const session = await this.find(this.db, tenant, id);
    return (await this.present(tenant, [session], true))[0];
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = parse(countSessionCreateSchema, raw, "Check the count.");
    if (payload.id) {
      const [taken] = await this.db.select().from(stockCountSessions).where(eq(stockCountSessions.id, payload.id)).limit(1);
      if (taken && taken.tenantId === tenant.tenantId) return this.get(tenant, taken.id);
      if (taken) throw new ApiError("ID_CONFLICT", "This record ID is already used. Create a new one and try again.", 409);
    }
    const business = await requireBusiness(this.db, tenant);
    const branch = await resolveBranch(this.db, tenant, business.id, payload.branchId);
    const id = payload.id ?? newId();
    await this.db.insert(stockCountSessions).values({
      id,
      tenantId: tenant.tenantId,
      businessId: business.id,
      branchId: branch.id,
      status: "counting",
      name: payload.name,
      note: payload.note ?? null,
      createdBy: tenant.userId,
      createdMembershipId: tenant.membershipId,
    });
    await this.record(this.db, tenant, business.id, branch.id, "stock.count_session_started", id, { name: payload.name });
    return this.get(tenant, id);
  }

  /** Counting a product (again) in this session. The expected quantity is what the system holds now. */
  async count(tenant: TenantContext, id: string, raw: unknown, options: { countedAt?: Date } = {}) {
    const payload = parse(countSessionLineSchema, raw, "Check the count.");
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status !== "counting" && session.status !== "draft") throw new ApiError("COUNT_NOT_OPEN", "This count has been submitted. Ask for it back to change it.", 409);
      const product = await requireProduct(tx, tenant, session.businessId, payload.productId);
      if (!product.trackStock) throw new ApiError("STOCK_NOT_TRACKED", `Stock is not counted for ${product.name}.`, 422, [{ field: "productId", message: "Not counted." }]);
      const units = (await productUnitsFor(tx, tenant.tenantId, [product.id])).get(product.id) ?? [];
      const entered = parseCountQuantity(payload.countedQuantity) as bigint;
      const counted = (entered * unitFactor(product, units, payload.unit) + 500n) / 1000n;
      // Counted offline: compared with the stock when it was counted, not when it arrived (ADR-064).
      const countedAt = countTime(options.countedAt, session.createdAt);
      const expected = await balanceAt(tx, tenant.tenantId, session.branchId, product.id, countedAt);
      const difference = counted - expected;
      const values = {
        systemQuantity: expected,
        countedQuantity: counted,
        difference,
        enteredQuantity: entered,
        enteredUnit: payload.unit,
        // A difference always carries a reason; a count correction unless the counter says otherwise.
        reason: difference === 0n ? null : (payload.reason ?? "count_correction"),
        note: payload.note ?? null,
        countedBy: tenant.userId,
        countedMembershipId: tenant.membershipId,
        deviceId: tenant.deviceId ?? null,
        countedAt: countedAt ?? new Date(),
      };
      await tx
        .insert(stockCountSessionLines)
        .values({ id: newId(), tenantId: tenant.tenantId, businessId: session.businessId, sessionId: id, productId: product.id, ...values })
        .onConflictDoUpdate({ target: [stockCountSessionLines.sessionId, stockCountSessionLines.productId], set: values });
      await tx.update(stockCountSessions).set({ status: "counting", updatedAt: new Date() }).where(eq(stockCountSessions.id, id));
    });
    return this.get(tenant, id);
  }

  async removeLine(tenant: TenantContext, id: string, productId: string) {
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status !== "counting" && session.status !== "draft") throw new ApiError("COUNT_NOT_OPEN", "This count has been submitted. Ask for it back to change it.", 409);
      await tx.delete(stockCountSessionLines).where(and(eq(stockCountSessionLines.tenantId, tenant.tenantId), eq(stockCountSessionLines.sessionId, id), eq(stockCountSessionLines.productId, productId)));
    });
    return this.get(tenant, id);
  }

  async submit(tenant: TenantContext, id: string) {
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status !== "counting") throw new ApiError("COUNT_NOT_OPEN", "This count is not open.", 409);
      const lines = await this.lines(tx, tenant.tenantId, [id]);
      if (lines.length === 0) throw new ApiError("COUNT_EMPTY", "Count at least one product before you submit.", 422);
      await tx.update(stockCountSessions).set({ status: "submitted", submittedBy: tenant.userId, submittedAt: new Date(), updatedAt: new Date() }).where(eq(stockCountSessions.id, id));
      await this.record(tx, tenant, session.businessId, session.branchId, "stock.count_session_submitted", id, { lines: lines.length, withDifference: lines.filter((line) => line.difference !== 0n).length });
    });
    return this.get(tenant, id);
  }

  /** Approving posts every difference as a `counted` movement, in one transaction. */
  async approve(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = parse(countSessionDecisionSchema, raw, "Check the note.");
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status !== "submitted") throw new ApiError("COUNT_NOT_SUBMITTED", "Only a submitted count can be approved.", 409);
      const lines = await this.lines(tx, tenant.tenantId, [id]);
      for (const line of lines) {
        if (line.difference === 0n) continue;
        const context = await this.stock.context(tx, tenant, line.productId, session.branchId, { anyBranchInScope: true });
        const movement = await this.stock.applyMovement(tx, context, {
          type: "counted",
          mayGoBelowZero: true,
          quantity: line.difference,
          enteredQuantity: line.enteredQuantity,
          enteredUnit: line.enteredUnit,
          reason: line.reason ?? (line.difference < 0n ? "count_short" : "count_over"),
          note: [session.name, line.note, note].filter((part): part is string => Boolean(part)).join(" · ").slice(0, 240),
          countId: line.id,
        });
        await tx.update(stockCountSessionLines).set({ movementId: movement.id }).where(eq(stockCountSessionLines.id, line.id));
      }
      const now = new Date();
      await tx.update(stockCountSessions).set({ status: "posted", approvedBy: tenant.userId, approvedAt: now, postedAt: now, decisionNote: note ?? null, updatedAt: now }).where(eq(stockCountSessions.id, id));
      await this.record(tx, tenant, session.businessId, session.branchId, "stock.count_session_posted", id, { note: note ?? null, posted: lines.filter((line) => line.difference !== 0n).length });
    });
    return this.get(tenant, id);
  }

  /** Sends a submitted count back to the counters, with a reason. */
  async reject(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = parse(countSessionRejectSchema, raw, "Say why the count goes back.");
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status !== "submitted") throw new ApiError("COUNT_NOT_SUBMITTED", "Only a submitted count can be sent back.", 409);
      await tx.update(stockCountSessions).set({ status: "counting", decisionNote: note, updatedAt: new Date() }).where(eq(stockCountSessions.id, id));
      await this.record(tx, tenant, session.businessId, session.branchId, "stock.count_session_returned", id, { note });
    });
    return this.get(tenant, id);
  }

  async cancel(tenant: TenantContext, id: string) {
    await this.db.transaction(async (tx) => {
      const session = await this.find(tx, tenant, id, { lock: true });
      if (session.status === "posted" || session.status === "cancelled") throw new ApiError("COUNT_CLOSED", "This count is already closed.", 409);
      if (session.createdBy !== tenant.userId && !tenant.permissions.includes(Permission.STOCK_ADJUST)) {
        throw new ApiError("FORBIDDEN", "Only the person who started this count, or a manager, can cancel it.", 403);
      }
      await tx.update(stockCountSessions).set({ status: "cancelled", cancelledBy: tenant.userId, cancelledAt: new Date(), updatedAt: new Date() }).where(eq(stockCountSessions.id, id));
      await this.record(tx, tenant, session.businessId, session.branchId, "stock.count_session_cancelled", id, {});
    });
    return this.get(tenant, id);
  }

  private async find(executor: DbExecutor, tenant: TenantContext, id: string, options: { lock?: boolean } = {}) {
    const business = await requireBusiness(executor, tenant);
    const query = executor
      .select()
      .from(stockCountSessions)
      .where(and(eq(stockCountSessions.tenantId, tenant.tenantId), eq(stockCountSessions.businessId, business.id), eq(stockCountSessions.id, id)))
      .limit(1);
    const [session] = options.lock ? await query.for("update") : await query;
    if (!session || (tenant.membershipBranchId && session.branchId !== tenant.membershipBranchId)) throw new ApiError("COUNT_NOT_FOUND", "This count was not found.", 404);
    return session;
  }

  private lines(executor: DbExecutor, tenantId: string, ids: string[]) {
    return executor.select().from(stockCountSessionLines).where(and(eq(stockCountSessionLines.tenantId, tenantId), inArray(stockCountSessionLines.sessionId, ids))).orderBy(asc(stockCountSessionLines.countedAt));
  }

  private async present(tenant: TenantContext, rows: SessionRow[], withLines: boolean) {
    const ids = rows.map((row) => row.id);
    const lines = ids.length ? await this.lines(this.db, tenant.tenantId, ids) : [];
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const names = productIds.length ? await this.db.select({ id: products.id, name: products.name, baseUnit: products.baseUnit }).from(products).where(and(eq(products.tenantId, tenant.tenantId), inArray(products.id, productIds))) : [];
    const places = ids.length ? await this.db.select({ id: branches.id, name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenant.tenantId), inArray(branches.id, [...new Set(rows.map((row) => row.branchId))]))) : [];
    return rows.map((row) => {
      const own = lines.filter((line) => line.sessionId === row.id);
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        branch: places.find((place) => place.id === row.branchId) ?? { id: row.branchId, name: "" },
        note: row.note,
        decisionNote: row.decisionNote,
        createdAt: row.createdAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        postedAt: row.postedAt?.toISOString() ?? null,
        mine: row.createdBy === tenant.userId,
        counted: own.length,
        withDifference: own.filter((line) => line.difference !== 0n).length,
        ...(withLines
          ? {
              lines: own.map((line) => {
                const product = names.find((item) => item.id === line.productId);
                return {
                  id: line.id,
                  productId: line.productId,
                  productName: product?.name ?? "",
                  baseUnit: product?.baseUnit ?? line.enteredUnit,
                  systemQuantity: line.systemQuantity.toString(),
                  countedQuantity: line.countedQuantity.toString(),
                  difference: line.difference.toString(),
                  reason: line.reason,
                  note: line.note,
                  countedAt: line.countedAt.toISOString(),
                };
              }),
            }
          : {}),
      };
    });
  }

  private async record(executor: DbExecutor, tenant: TenantContext, businessId: string, branchId: string, action: string, id: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType: "stock_count_session", entityId: id, correlationId: tenant.correlationId, businessId, branchId, actorType: tenant.actorType ?? "HUMAN", metadata },
      executor,
    );
  }
}
