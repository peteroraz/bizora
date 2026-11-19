import { Inject, Injectable } from "@nestjs/common";
import { supplierReturnSchema, stockAdjustSchema, stockReceiveSchema, stockRequestDecisionSchema, stockRequestRejectSchema, stockTransferSchema } from "@bizora/contracts";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, stockRequests, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { requireBusiness } from "./inventory-scope.js";
import { StockService } from "./stock.service.js";

type RequestRow = typeof stockRequests.$inferSelect;

/**
 * A store keeper's stock in, changes and moves wait here until a manager or owner approves and completes them, or
 * rejects them with a reason (ADR-034). Giving out goods that are paid for never waits.
 */
@Injectable()
export class StockRequestService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** Approvers see what waits in their shops, then the latest decided; others see their own requests. */
  async list(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const mine = this.stock.needsApproval(tenant);
    const scope = and(
      eq(stockRequests.tenantId, tenant.tenantId),
      eq(stockRequests.businessId, business.id),
      mine ? eq(stockRequests.requestedMembershipId, tenant.membershipId) : undefined,
      tenant.membershipBranchId ? eq(stockRequests.branchId, tenant.membershipBranchId) : tenant.branchId ? eq(stockRequests.branchId, tenant.branchId) : undefined,
    );
    const [waiting, decided] = await Promise.all([
      this.db.select().from(stockRequests).where(and(scope, eq(stockRequests.status, "pending"))).orderBy(stockRequests.requestedAt).limit(200),
      this.db.select().from(stockRequests).where(and(scope, or(eq(stockRequests.status, "approved"), eq(stockRequests.status, "rejected")))).orderBy(desc(stockRequests.decidedAt)).limit(20),
    ]);
    return { canApprove: !mine, waiting: await this.present(tenant, waiting), decided: await this.present(tenant, decided) };
  }

  /** Completes the change as asked, checked again now, and tells the person who asked. */
  async approve(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = stockRequestDecisionSchema.parse(raw ?? {});
    return this.db.transaction(async (tx) => {
      const row = await this.pending(tx, tenant, id);
      const result =
        row.kind === "receive"
          ? await this.stock.receiveIn(tx, tenant, stockReceiveSchema.parse(row.payload))
          : row.kind === "adjust"
            ? await this.stock.adjustIn(tx, tenant, stockAdjustSchema.parse(row.payload))
            : row.kind === "supplier_return"
              ? await this.stock.returnToSupplierIn(tx, tenant, supplierReturnSchema.parse(row.payload))
              : await this.stock.transferIn(tx, tenant, stockTransferSchema.parse(row.payload));
      const movementId = "movementId" in result ? result.movementId : result.id;
      const [done] = await tx
        .update(stockRequests)
        .set({ status: "approved", decidedBy: tenant.userId, decidedAt: new Date(), decisionNote: note || null, resultMovementId: movementId })
        .where(and(eq(stockRequests.tenantId, tenant.tenantId), eq(stockRequests.id, row.id)))
        .returning();
      await this.decided(tx, tenant, done as RequestRow, "stock.request_approved");
      return (await this.present(tenant, [done as RequestRow], tx))[0];
    });
  }

  async reject(tenant: TenantContext, id: string, raw: unknown) {
    const { note } = stockRequestRejectSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const row = await this.pending(tx, tenant, id);
      const [done] = await tx
        .update(stockRequests)
        .set({ status: "rejected", decidedBy: tenant.userId, decidedAt: new Date(), decisionNote: note })
        .where(and(eq(stockRequests.tenantId, tenant.tenantId), eq(stockRequests.id, row.id)))
        .returning();
      await this.decided(tx, tenant, done as RequestRow, "stock.request_rejected");
      return (await this.present(tenant, [done as RequestRow], tx))[0];
    });
  }

  private async pending(tx: DbExecutor, tenant: TenantContext, id: string) {
    if (this.stock.needsApproval(tenant)) throw new ApiError("FORBIDDEN", "Only a manager or the owner can approve stock changes.", 403);
    const business = await requireBusiness(tx, tenant);
    const [row] = await tx
      .select()
      .from(stockRequests)
      .where(and(eq(stockRequests.tenantId, tenant.tenantId), eq(stockRequests.businessId, business.id), eq(stockRequests.id, id)))
      .for("update")
      .limit(1);
    if (!row || (tenant.membershipBranchId && row.branchId !== tenant.membershipBranchId)) throw new ApiError("NOT_FOUND", "That request was not found.", 404);
    if (row.status !== "pending") throw new ApiError("ALREADY_DECIDED", "This request was already decided.", 409);
    return row;
  }

  private async decided(tx: DbExecutor, tenant: TenantContext, row: RequestRow, action: "stock.request_approved" | "stock.request_rejected") {
    const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, tenant.userId)).limit(1);
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "product",
        entityId: row.productId,
        correlationId: tenant.correlationId,
        businessId: row.businessId,
        branchId: row.branchId,
        metadata: { requestId: row.id, kind: row.kind, summary: row.summary, note: row.decisionNote, requestedBy: row.requestedBy, movementOrCountId: row.resultMovementId },
        actorType: tenant.actorType ?? "HUMAN",
      },
      tx,
    );
    await this.notifications.notify(tx, tenant.tenantId, [row.requestedMembershipId], {
      kind: action,
      saleId: null,
      actorName: me?.name ?? null,
      data: { summary: row.summary.slice(0, 160), note: row.decisionNote },
      except: tenant.membershipId,
    });
  }

  private async present(tenant: TenantContext, rows: RequestRow[], executor: DbExecutor = this.db) {
    if (rows.length === 0) return [];
    const people = [...new Set(rows.flatMap((row) => [row.requestedBy, row.decidedBy]).filter((value): value is string => Boolean(value)))];
    const shops = [...new Set(rows.map((row) => row.branchId))];
    const [names, shopNames] = await Promise.all([
      executor.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, people)),
      executor.select({ id: branches.id, name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenant.tenantId), inArray(branches.id, shops))),
    ]);
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    const shopOf = new Map(shopNames.map((row) => [row.id, row.name]));
    return rows.map((row) => this.stock.presentRequest(row, nameOf.get(row.requestedBy) ?? null, shopOf.get(row.branchId) ?? null, row.decidedBy ? (nameOf.get(row.decidedBy) ?? null) : null));
  }
}

