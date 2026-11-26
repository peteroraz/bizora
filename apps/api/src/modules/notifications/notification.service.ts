import { Inject, Injectable } from "@nestjs/common";
import { notificationReadSchema } from "@bizora/contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { notifications, sales } from "../../db/schema.js";
import { DB } from "../../tokens.js";

export type NotificationKind = "sale.paid" | "sale.credit" | "sale.released" | "sale.comment" | "sale.voided" | "sale.below_price" | "sale.credit_offline" | "sale.closed_shop" | "sale.typed_like_product" | "sale.serial_conflict" | "transfer.waiting" | "transfer.not_received" | "stock.request" | "stock.request_approved" | "stock.request_rejected" | "work.locked_offline" | "work.after_hours_offline" | "business.suspended" | "business.reinstated";

const INBOX_SIZE = 30;

/**
 * In-app notifications (ADR-016): one row per person (membership). They hold the sale and who acted, never amounts
 * or customer details, so a store keeper's list shows nothing their job does not need.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async notify(
    tx: DbExecutor,
    tenantId: string,
    recipients: Iterable<string | null | undefined>,
    input: { kind: NotificationKind; saleId: string | null; actorName: string | null; data?: Record<string, unknown>; except?: string },
  ) {
    const unique = [...new Set([...recipients].filter((id): id is string => Boolean(id) && id !== input.except))];
    if (unique.length === 0) return;
    await tx.insert(notifications).values(
      unique.map((membershipId) => ({
        id: newId(),
        tenantId,
        membershipId,
        kind: input.kind,
        saleId: input.saleId,
        actorName: input.actorName?.slice(0, 160) ?? null,
        data: input.data ?? {},
      })),
    );
  }

  async list(tenant: TenantContext) {
    const mine = and(eq(notifications.tenantId, tenant.tenantId), eq(notifications.membershipId, tenant.membershipId));
    const [rows, unread] = await Promise.all([
      this.db
        .select({ notification: notifications, saleNumber: sql<string | null>`coalesce(${sales.saleNumber}, ${sales.invoiceNumber})` })
        .from(notifications)
        .leftJoin(sales, and(eq(sales.tenantId, notifications.tenantId), eq(sales.id, notifications.saleId)))
        .where(mine)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(INBOX_SIZE),
      this.db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt))),
    ]);
    return {
      unread: Number(unread[0]?.count ?? 0),
      items: rows.map(({ notification, saleNumber }) => ({
        id: notification.id,
        kind: notification.kind,
        saleId: notification.saleId,
        saleNumber,
        actorName: notification.actorName,
        data: notification.data,
        read: notification.readAt !== null,
        createdAt: notification.createdAt.toISOString(),
      })),
    };
  }

  async markRead(tenant: TenantContext, raw: unknown) {
    const payload = notificationReadSchema.parse(raw ?? {});
    const filters = [eq(notifications.tenantId, tenant.tenantId), eq(notifications.membershipId, tenant.membershipId), isNull(notifications.readAt)];
    if (!payload.all) {
      if (!payload.ids || payload.ids.length === 0) return this.list(tenant);
      filters.push(inArray(notifications.id, payload.ids));
    }
    await this.db.update(notifications).set({ readAt: new Date() }).where(and(...filters));
    return this.list(tenant);
  }
}
