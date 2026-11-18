import { Inject, Injectable } from "@nestjs/common";
import { transferConfirmSchema, transferNotReceivedSchema, type TransferKind } from "@bizora/contracts";
import { aliasedTable, and, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { branches, customerPayments, customers, salePayments, sales, users } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness } from "../inventory/inventory-scope.js";
import { ChartOfAccountsService } from "../ledger/chart-of-accounts.service.js";
import { LedgerPostingService } from "../ledger/ledger-posting.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { PaymentService } from "./payment.service.js";

const RECENT_LIMIT = 20;
const WAITING_LIMIT = 200;

type Item = {
  kind: TransferKind;
  id: string;
  amountMinor: string;
  reference: string | null;
  number: string | null;
  saleId: string | null;
  customerId: string | null;
  customerName: string | null;
  branchName: string | null;
  recordedByName: string | null;
  recordedAt: string;
  confirmation: string;
  confirmedVia: string | null;
  notReceivedAs: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  note: string | null;
};

/**
 * Transfers waiting for confirmation (ADR-031). Staff who cannot see the bank record transfers into
 * "Transfers waiting for confirmation" (1160). Someone who can (bank.reconcile) confirms each one, which moves it to
 * the bank, or says it never came: then the customer owes it again, or it is written off as lost (6960).
 * A bank statement line that matches a waiting transfer confirms it too.
 */
@Injectable()
export class TransferService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(LedgerPostingService) private readonly ledger: LedgerPostingService,
    @Inject(ChartOfAccountsService) private readonly chart: ChartOfAccountsService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** What is waiting, and the last transfers checked. Shop-bound staff see their own shop. */
  async list(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const shop = tenant.membershipBranchId ?? null;
    const [saleWaiting, paymentWaiting, saleRecent, paymentRecent] = await Promise.all([
      this.saleItems(tenant.tenantId, business.id, shop, "waiting", WAITING_LIMIT),
      this.paymentItems(tenant.tenantId, business.id, shop, "waiting", WAITING_LIMIT),
      this.saleItems(tenant.tenantId, business.id, shop, "checked", RECENT_LIMIT),
      this.paymentItems(tenant.tenantId, business.id, shop, "checked", RECENT_LIMIT),
    ]);
    const waiting = [...saleWaiting, ...paymentWaiting].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const recent = [...saleRecent, ...paymentRecent].sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "")).slice(0, RECENT_LIMIT);
    return {
      waiting,
      waitingCount: waiting.length,
      waitingMinor: waiting.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n).toString(),
      recent,
    };
  }

  /** "It came in": moves the transfer from waiting to the bank. */
  async confirm(tenant: TenantContext, kind: TransferKind, id: string, raw: unknown) {
    const { note } = transferConfirmSchema.parse(raw ?? {});
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const today = localDate(new Date(), business.timezone);
      const entryId = await this.confirmIn(tx, tenant, kind, id, { entryDate: today, via: "by_hand", note });
      if (!entryId) throw new ApiError("NOT_WAITING", "This transfer has already been checked.", 409);
    });
    return this.item(tenant, kind, id);
  }

  /**
   * Confirms a waiting transfer inside the caller's transaction. Used by the button above and by bank statement
   * matching (ADR-020). Returns the entry that moved it to the bank, or null when it was not waiting.
   */
  async confirmIn(
    tx: DbExecutor,
    tenant: TenantContext,
    kind: TransferKind,
    id: string,
    options: { entryDate: string; via: "by_hand" | "bank_statement"; note?: string | undefined },
  ): Promise<string | null> {
    const business = await requireBusiness(tx, tenant);
    const payment = await this.lock(tx, tenant, business.id, kind, id);
    if (payment.confirmation !== "waiting") return null;
    await this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId);
    const posted = await this.ledger.post(
      tx,
      { tenantId: tenant.tenantId, userId: tenant.userId },
      {
        businessId: business.id,
        branchId: payment.branchId,
        entryDate: options.entryDate,
        source: { type: "transfer_check", id },
        postingKey: `transfer_check:${id}:${Date.now()}`,
        description: `Transfer for ${payment.number ?? "a sale"} came in`,
        lines: [
          { account: { role: "bank" }, debitMinor: payment.amount, memo: payment.reference ?? undefined },
          { account: { role: "transfers_waiting" }, creditMinor: payment.amount },
        ],
      },
    );
    const set = {
      confirmation: "confirmed",
      confirmedVia: options.via,
      confirmedBy: tenant.userId,
      confirmedAt: new Date(),
      confirmationEntryId: posted.entryId,
      confirmationNote: options.note ?? null,
    };
    if (kind === "sale_payment") await tx.update(salePayments).set(set).where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.id, id)));
    else await tx.update(customerPayments).set(set).where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.id, id)));
    await this.record(tx, tenant, business.id, "transfer.confirmed", id, { kind, number: payment.number, amountMinor: payment.amount.toString(), via: options.via });
    return posted.entryId;
  }

  /** A bank statement match was undone: the transfer it confirmed waits again. The caller reverses the entry. */
  async resetIn(tx: DbExecutor, tenant: TenantContext, entryId: string) {
    const set = { confirmation: "waiting", confirmedVia: null, confirmedBy: null, confirmedAt: null, confirmationEntryId: null, confirmationNote: null };
    await tx.update(salePayments).set(set).where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.confirmationEntryId, entryId)));
    await tx.update(customerPayments).set(set).where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.confirmationEntryId, entryId)));
  }

  /**
   * "It never came". On a sale: the customer owes it again (when the sale has a customer) or it is written off as
   * lost. A later payment from a customer who owes is cancelled, so they owe it again.
   */
  async notReceived(tenant: TenantContext, kind: TransferKind, id: string, raw: unknown) {
    const input = transferNotReceivedSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const payment = await this.lock(tx, tenant, business.id, kind, id);
      if (payment.confirmation !== "waiting") throw new ApiError("NOT_WAITING", "This transfer has already been checked.", 409);
      const now = new Date();
      const today = localDate(now, business.timezone);
      if (kind === "customer_payment") {
        await this.payments.voidIn(tx, tenant, id, `Transfer never came: ${input.reason}`);
        await tx
          .update(customerPayments)
          .set({ confirmation: "not_received", confirmedBy: tenant.userId, confirmedAt: now, confirmationNote: input.reason })
          .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.id, id)));
      } else {
        const owed = input.settle === "owed";
        if (owed && !payment.customerId) {
          throw new ApiError("NO_CUSTOMER", "This sale has no customer to owe it. Write it off as lost instead.", 400, [{ field: "settle", message: "No customer on this sale." }]);
        }
        await this.chart.ensure(tx, tenant.tenantId, business.id, tenant.userId);
        const posted = await this.ledger.post(
          tx,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          {
            businessId: business.id,
            branchId: payment.branchId,
            entryDate: today,
            source: { type: "transfer_check", id },
            postingKey: `transfer_check:${id}:${Date.now()}`,
            description: `Transfer for ${payment.number ?? "a sale"} never came`,
            lines: [
              { account: { role: owed ? "debtors" : "transfers_lost" }, debitMinor: payment.amount, memo: owed ? (payment.customerName ?? undefined) : input.reason },
              { account: { role: "transfers_waiting" }, creditMinor: payment.amount },
            ],
          },
        );
        if (owed && payment.saleId) {
          await tx
            .update(sales)
            .set({
              paidMinor: sql`${sales.paidMinor} - ${payment.amount}`,
              balanceMinor: sql`${sales.balanceMinor} + ${payment.amount}`,
              dueDate: sql`coalesce(${sales.dueDate}, ${today}::date)`,
            })
            .where(and(eq(sales.tenantId, tenant.tenantId), eq(sales.id, payment.saleId)));
        }
        await tx
          .update(salePayments)
          .set({
            confirmation: "not_received",
            notReceivedAs: input.settle,
            confirmedBy: tenant.userId,
            confirmedAt: now,
            confirmationEntryId: posted.entryId,
            confirmationNote: input.reason,
          })
          .where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.id, id)));
      }
      // The person who recorded it is told, so they know to talk to the customer.
      if (payment.recordedMembershipId) {
        await this.notifications.notify(tx, tenant.tenantId, [payment.recordedMembershipId], {
          kind: "transfer.not_received",
          saleId: payment.saleId,
          actorName: await this.actorName(tx, tenant.userId),
          data: { number: payment.number },
          except: tenant.membershipId,
        });
      }
      await this.record(tx, tenant, business.id, "transfer.not_received", id, {
        kind,
        number: payment.number,
        amountMinor: payment.amount.toString(),
        settle: kind === "customer_payment" ? "owed" : input.settle,
        reason: input.reason,
      });
    });
    return this.item(tenant, kind, id);
  }

  private async item(tenant: TenantContext, kind: TransferKind, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const items = kind === "sale_payment" ? await this.saleItems(tenant.tenantId, business.id, null, "any", 1, id) : await this.paymentItems(tenant.tenantId, business.id, null, "any", 1, id);
    const item = items[0];
    if (!item) throw new ApiError("NOT_FOUND", "Transfer not found.", 404);
    return { transfer: item };
  }

  /** Locks the payment and returns what the checks need. Voided sales and cancelled payments are not transfers to check. */
  private async lock(tx: DbExecutor, tenant: TenantContext, businessId: string, kind: TransferKind, id: string) {
    if (kind === "sale_payment") {
      const [row] = await tx
        .select({
          confirmation: salePayments.confirmation,
          amount: salePayments.amountMinor,
          reference: salePayments.reference,
          saleId: sales.id,
          number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
          branchId: sales.branchId,
          customerId: sales.customerId,
          customerName: customers.name,
          status: sales.status,
          recordedMembershipId: sql<string | null>`coalesce(${sales.collectedMembershipId}, ${sales.membershipId})`,
        })
        .from(salePayments)
        .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
        .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
        .where(and(eq(salePayments.tenantId, tenant.tenantId), eq(salePayments.businessId, businessId), eq(salePayments.id, id)))
        .for("update", { of: salePayments })
        .limit(1);
      if (!row || row.status === "voided") throw new ApiError("NOT_FOUND", "Transfer not found.", 404);
      this.ownShop(tenant, row.branchId);
      return row;
    }
    const [row] = await tx
      .select({
        confirmation: customerPayments.confirmation,
        amount: customerPayments.amountMinor,
        reference: customerPayments.reference,
        number: customerPayments.paymentNumber,
        branchId: customerPayments.branchId,
        customerId: customerPayments.customerId,
        customerName: customers.name,
        status: customerPayments.status,
        recordedMembershipId: customerPayments.membershipId,
      })
      .from(customerPayments)
      .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
      .where(and(eq(customerPayments.tenantId, tenant.tenantId), eq(customerPayments.businessId, businessId), eq(customerPayments.id, id)))
      .for("update", { of: customerPayments })
      .limit(1);
    if (!row || row.status === "voided") throw new ApiError("NOT_FOUND", "Transfer not found.", 404);
    this.ownShop(tenant, row.branchId);
    return { ...row, saleId: null as string | null };
  }

  private ownShop(tenant: TenantContext, branchId: string) {
    if (tenant.membershipBranchId && tenant.membershipBranchId !== branchId) throw new ApiError("NOT_FOUND", "Transfer not found.", 404);
  }

  private async saleItems(tenantId: string, businessId: string, shop: string | null, which: "waiting" | "checked" | "any", limit: number, id?: string): Promise<Item[]> {
    const recorder = aliasedTable(users, "recorder");
    const checker = aliasedTable(users, "checker");
    const rows = await this.db
      .select({
        id: salePayments.id,
        amount: salePayments.amountMinor,
        reference: salePayments.reference,
        confirmation: salePayments.confirmation,
        confirmedVia: salePayments.confirmedVia,
        notReceivedAs: salePayments.notReceivedAs,
        checkedAt: salePayments.confirmedAt,
        note: salePayments.confirmationNote,
        saleId: sales.id,
        number: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})`,
        customerId: sales.customerId,
        customerName: customers.name,
        branchName: branches.name,
        recordedByName: recorder.displayName,
        recordedAt: sql<Date>`coalesce(${sales.collectedAt}, ${sales.soldAt})`,
        checkedByName: checker.displayName,
      })
      .from(salePayments)
      .innerJoin(sales, and(eq(sales.tenantId, salePayments.tenantId), eq(sales.id, salePayments.saleId)))
      .leftJoin(customers, and(eq(customers.tenantId, sales.tenantId), eq(customers.id, sales.customerId)))
      .leftJoin(branches, and(eq(branches.tenantId, sales.tenantId), eq(branches.id, sales.branchId)))
      .leftJoin(recorder, eq(recorder.id, sql`coalesce(${sales.collectedBy}, ${sales.createdBy})`))
      .leftJoin(checker, eq(checker.id, salePayments.confirmedBy))
      .where(
        and(
          eq(salePayments.tenantId, tenantId),
          eq(salePayments.businessId, businessId),
          ne(sales.status, "voided"),
          ...(shop ? [eq(sales.branchId, shop)] : []),
          ...(id ? [eq(salePayments.id, id)] : []),
          ...(which === "waiting" ? [eq(salePayments.confirmation, "waiting")] : []),
          ...(which === "checked"
            ? [or(eq(salePayments.confirmation, "not_received"), and(eq(salePayments.confirmation, "confirmed"), isNotNull(salePayments.confirmedVia)))]
            : []),
        ),
      )
      .orderBy(which === "checked" ? desc(salePayments.confirmedAt) : sql`coalesce(${sales.collectedAt}, ${sales.soldAt})`)
      .limit(limit);
    return rows.map((row) => ({
      kind: "sale_payment",
      id: row.id,
      amountMinor: row.amount.toString(),
      reference: row.reference,
      number: row.number,
      saleId: row.saleId,
      customerId: row.customerId,
      customerName: row.customerName,
      branchName: row.branchName,
      recordedByName: row.recordedByName,
      recordedAt: new Date(row.recordedAt).toISOString(),
      confirmation: row.confirmation,
      confirmedVia: row.confirmedVia,
      notReceivedAs: row.notReceivedAs,
      checkedByName: row.checkedByName,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      note: row.note,
    }));
  }

  private async paymentItems(tenantId: string, businessId: string, shop: string | null, which: "waiting" | "checked" | "any", limit: number, id?: string): Promise<Item[]> {
    const recorder = aliasedTable(users, "recorder");
    const checker = aliasedTable(users, "checker");
    const rows = await this.db
      .select({
        id: customerPayments.id,
        amount: customerPayments.amountMinor,
        reference: customerPayments.reference,
        confirmation: customerPayments.confirmation,
        confirmedVia: customerPayments.confirmedVia,
        checkedAt: customerPayments.confirmedAt,
        note: customerPayments.confirmationNote,
        number: customerPayments.paymentNumber,
        customerId: customerPayments.customerId,
        customerName: customers.name,
        branchName: branches.name,
        recordedByName: recorder.displayName,
        recordedAt: customerPayments.receivedAt,
        checkedByName: checker.displayName,
      })
      .from(customerPayments)
      .innerJoin(customers, and(eq(customers.tenantId, customerPayments.tenantId), eq(customers.id, customerPayments.customerId)))
      .leftJoin(branches, and(eq(branches.tenantId, customerPayments.tenantId), eq(branches.id, customerPayments.branchId)))
      .leftJoin(recorder, eq(recorder.id, customerPayments.createdBy))
      .leftJoin(checker, eq(checker.id, customerPayments.confirmedBy))
      .where(
        and(
          eq(customerPayments.tenantId, tenantId),
          eq(customerPayments.businessId, businessId),
          ...(shop ? [eq(customerPayments.branchId, shop)] : []),
          ...(id ? [eq(customerPayments.id, id)] : []),
          ...(which === "waiting" ? [eq(customerPayments.confirmation, "waiting"), eq(customerPayments.status, "recorded")] : []),
          ...(which === "checked"
            ? [
                or(
                  eq(customerPayments.confirmation, "not_received"),
                  and(eq(customerPayments.confirmation, "confirmed"), isNotNull(customerPayments.confirmedVia), eq(customerPayments.status, "recorded")),
                ),
              ]
            : []),
        ),
      )
      .orderBy(which === "checked" ? desc(customerPayments.confirmedAt) : customerPayments.receivedAt)
      .limit(limit);
    return rows.map((row) => ({
      kind: "customer_payment",
      id: row.id,
      amountMinor: row.amount.toString(),
      reference: row.reference,
      number: row.number,
      saleId: null,
      customerId: row.customerId,
      customerName: row.customerName,
      branchName: row.branchName,
      recordedByName: row.recordedByName,
      recordedAt: row.recordedAt.toISOString(),
      confirmation: row.confirmation,
      confirmedVia: row.confirmedVia,
      notReceivedAs: row.confirmation === "not_received" ? "owed" : null,
      checkedByName: row.checkedByName,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      note: row.note,
    }));
  }

  private async actorName(tx: DbExecutor, userId: string) {
    const [row] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.name ?? null;
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        action,
        entityType: "transfer",
        entityId,
        correlationId: tenant.correlationId,
        businessId,
        actorType: tenant.actorType ?? "HUMAN",
        metadata,
      },
      tx,
    );
  }
}
