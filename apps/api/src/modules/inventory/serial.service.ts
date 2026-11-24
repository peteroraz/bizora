import { Inject, Injectable } from "@nestjs/common";
import { Permission, normalizeSerial, saleSerialsSchema } from "@bizora/contracts";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { memberships } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { type ProductRow, requireBusiness, requireProduct, resolveBranch } from "./inventory-scope.js";

/** Units with a serial number that can still be sold. A unit brought back by a customer can be sold again. */
const SELLABLE = ["in_stock", "returned"];

type SerialRow = { id: string; serial: string; status: string; product_id: string; branch_id: string; sale_id: string | null; sale_line_id: string | null };
type LineToSell = { saleLineId: string; product: Pick<ProductRow, "id" | "name" | "tracksSerials"> | null; quantity: bigint; serials: string[] };

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
const whole = (quantity: bigint) => (quantity > 0n ? quantity / 1000n : 0n);

/**
 * Serial numbers and IMEIs (ADR-062): one row per physical unit of a product that keeps them. A unit comes in with
 * stock in, leaves with a sale, and comes back with a return; a serial can be sold only once while it is sold. Stock
 * quantities and value still move through StockService.applyMovement; this only follows the units.
 */
@Injectable()
export class SerialService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** Units coming in. A serial already in stock is refused; one sold before (bought back) comes into stock again. */
  async receive(
    tx: DbExecutor,
    tenant: TenantContext,
    scope: { businessId: string; branchId: string; branchName: string; product: ProductRow },
    movementId: string,
    quantity: bigint,
    serials: string[] | undefined,
    at: Date,
  ) {
    if (!serials?.length) return;
    const { product } = scope;
    if (!product.tracksSerials) {
      throw new ApiError("SERIALS_NOT_KEPT", `${product.name} does not keep serial numbers. Turn it on for the product first.`, 422, [{ field: "serials", message: "Not kept for this product." }]);
    }
    if (quantity % 1000n !== 0n || BigInt(serials.length) > whole(quantity)) {
      throw new ApiError("SERIALS_TOO_MANY", `You entered ${serials.length} serial numbers for ${quantityWords(quantity)}.`, 422, [{ field: "serials", message: "One for each unit." }]);
    }
    for (const serial of serials) {
      const [existing] = await this.find(tx, tenant.tenantId, scope.businessId, product.id, serial);
      if (existing && SELLABLE.includes(existing.status)) {
        throw new ApiError("SERIAL_IN_STOCK", `${serial} is already in stock.`, 409, [{ field: "serials", message: `${serial} is already in stock.` }]);
      }
      const id = existing?.id ?? newId();
      if (existing) {
        await tx.execute(sql`
          UPDATE serial_numbers SET status = 'in_stock', branch_id = ${scope.branchId}, sale_id = NULL, sale_line_id = NULL, customer_id = NULL,
            received_movement_id = ${movementId}, received_at = ${at.toISOString()}::timestamptz, sold_at = NULL, updated_at = now()
          WHERE tenant_id = ${tenant.tenantId} AND id = ${id}`);
      } else {
        await tx.execute(sql`
          INSERT INTO serial_numbers (id, tenant_id, business_id, product_id, branch_id, serial, status, received_movement_id, received_at)
          VALUES (${id}, ${tenant.tenantId}, ${scope.businessId}, ${product.id}, ${scope.branchId}, ${serial}, 'in_stock', ${movementId}, ${at.toISOString()}::timestamptz)`);
      }
      await this.event(tx, tenant, id, existing ? "received_again" : "received", { branchId: scope.branchId, movementId });
    }
  }

  /**
   * Links serial numbers to a sale's lines. A sale made here and now is refused when a serial was already sold;
   * a sale that already happened (offline, typed in) is kept, the serial is left off, and the owner is told.
   * A serial never recorded coming in is recorded now, as sold.
   */
  async sell(
    tx: DbExecutor,
    tenant: TenantContext,
    sale: { businessId: string; branchId: string; saleId: string; customerId: string | null; soldAt: Date; live: boolean },
    lines: LineToSell[],
  ) {
    const conflicts: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.serials.length === 0) continue;
      const field = `lines.${index}.serials`;
      if (!line.product?.tracksSerials) {
        if (sale.live) throw new ApiError("SERIALS_NOT_KEPT", `${line.product?.name ?? "This item"} does not keep serial numbers.`, 422, [{ field, message: "Not kept for this item." }]);
        continue;
      }
      const product = line.product;
      const [{ taken } = { taken: "0" }] = rowsOf<{ taken: string }>(
        await tx.execute(sql`SELECT count(*)::text AS taken FROM serial_numbers WHERE tenant_id = ${tenant.tenantId} AND sale_line_id = ${line.saleLineId} AND status = 'sold'`),
      );
      let room = whole(line.quantity) - BigInt(taken);
      for (const serial of line.serials) {
        const [existing] = await this.find(tx, tenant.tenantId, sale.businessId, product.id, serial);
        if (existing?.sale_line_id === line.saleLineId && existing.status === "sold") continue;
        const problem =
          room <= 0n
            ? `${serial}: more serial numbers than ${product.name} sold.`
            : existing && !SELLABLE.includes(existing.status)
              ? `${serial} (${product.name}) was already ${existing.status === "sold" ? "sold" : `marked ${existing.status}`}.`
              : null;
        if (problem) {
          if (sale.live) throw new ApiError(room <= 0n ? "SERIALS_TOO_MANY" : "SERIAL_ALREADY_SOLD", problem, room <= 0n ? 422 : 409, [{ field, message: problem }]);
          conflicts.push(problem);
          continue;
        }
        const id = existing?.id ?? newId();
        if (existing) {
          await tx.execute(sql`
            UPDATE serial_numbers SET status = 'sold', branch_id = ${sale.branchId}, sale_id = ${sale.saleId}, sale_line_id = ${line.saleLineId},
              customer_id = ${sale.customerId}, sold_at = ${sale.soldAt.toISOString()}::timestamptz, updated_at = now()
            WHERE tenant_id = ${tenant.tenantId} AND id = ${id}`);
        } else {
          await tx.execute(sql`
            INSERT INTO serial_numbers (id, tenant_id, business_id, product_id, branch_id, serial, status, sale_id, sale_line_id, customer_id, sold_at)
            VALUES (${id}, ${tenant.tenantId}, ${sale.businessId}, ${product.id}, ${sale.branchId}, ${serial}, 'sold', ${sale.saleId}, ${line.saleLineId}, ${sale.customerId}, ${sale.soldAt.toISOString()}::timestamptz)`);
        }
        await this.event(tx, tenant, id, "sold", { branchId: sale.branchId, saleId: sale.saleId, note: existing ? null : "Not recorded when it came in" });
        room -= 1n;
      }
    }
    if (conflicts.length > 0) {
      const owners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.tenantId), eq(memberships.role, "OWNER"), eq(memberships.status, "ACTIVE")));
      await this.notifications.notify(tx, tenant.tenantId, owners.map((row) => row.id), {
        kind: "sale.serial_conflict",
        saleId: sale.saleId,
        actorName: null,
        data: { summary: conflicts.join(" ").slice(0, 400) },
      });
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "sale.serial_conflict", entityType: "sale", entityId: sale.saleId, correlationId: tenant.correlationId, businessId: sale.businessId, branchId: sale.branchId, metadata: { conflicts } },
        tx,
      );
    }
    return conflicts;
  }

  /** Serial numbers sent with a new sale, by line number (1 for the first line). */
  async sellNewSale(
    tx: DbExecutor,
    tenant: TenantContext,
    sale: { businessId: string; branchId: string; saleId: string; customerId: string | null; soldAt: Date; live: boolean },
    byLineNo: Map<number, string[]>,
  ) {
    if (byLineNo.size === 0) return [];
    const lines = await this.saleLines(tx, tenant.tenantId, sale.saleId);
    return this.sell(
      tx,
      tenant,
      sale,
      lines.map((line) => ({ ...line, serials: byLineNo.get(line.lineNo) ?? [] })),
    );
  }

  private async saleLines(tx: DbExecutor, tenantId: string, saleId: string) {
    const rows = rowsOf<{ id: string; line_no: number; product_id: string | null; quantity: string; name: string | null; tracks_serials: boolean | null }>(
      await tx.execute(sql`
        SELECT l.id, l.line_no, l.product_id, l.quantity::text AS quantity, p.name, p.tracks_serials FROM sale_lines l
        LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
        WHERE l.tenant_id = ${tenantId} AND l.sale_id = ${saleId} ORDER BY l.line_no`),
    );
    return rows.map((line) => ({
      saleLineId: line.id,
      lineNo: Number(line.line_no),
      product: line.product_id ? { id: line.product_id, name: line.name ?? "", tracksSerials: Boolean(line.tracks_serials) } : null,
      quantity: BigInt(line.quantity),
    }));
  }

  /** Serial numbers recorded after the sale, from the sale's page. */
  async addToSale(tenant: TenantContext, saleId: string, raw: unknown, sale: { businessId: string; branchId: string; customerId: string | null; soldAt: Date; status: string }) {
    const payload = saleSerialsSchema.parse(raw);
    if (sale.status === "voided") throw new ApiError("SALE_VOIDED", "This sale was cancelled.", 409);
    await this.db.transaction(async (tx) => {
      const lines = await this.saleLines(tx, tenant.tenantId, saleId);
      const byId = new Map(lines.map((line) => [line.saleLineId, line]));
      const toSell: LineToSell[] = payload.lines.map((entry, index) => {
        const line = byId.get(entry.saleLineId);
        if (!line) throw new ApiError("LINE_NOT_FOUND", "That line is not on this sale.", 404, [{ field: `lines.${index}.saleLineId`, message: "Not on this sale." }]);
        return { ...line, serials: entry.serials };
      });
      await this.sell(tx, tenant, { ...sale, saleId, live: true }, toSell);
      await this.audit.record(
        { tenantId: tenant.tenantId, actorUserId: tenant.userId, action: "sale.serials_added", entityType: "sale", entityId: saleId, correlationId: tenant.correlationId, businessId: sale.businessId, branchId: sale.branchId, metadata: { serials: payload.lines.flatMap((line) => line.serials) } },
        tx,
      );
    });
  }

  /** A cancelled sale: its units are back in stock. */
  async releaseSale(tx: DbExecutor, tenant: TenantContext, saleId: string) {
    const rows = rowsOf<{ id: string; branch_id: string }>(
      await tx.execute(sql`
        UPDATE serial_numbers SET status = 'in_stock', sale_id = NULL, sale_line_id = NULL, customer_id = NULL, sold_at = NULL, updated_at = now()
        WHERE tenant_id = ${tenant.tenantId} AND sale_id = ${saleId} AND status = 'sold' RETURNING id, branch_id`),
    );
    for (const row of rows) await this.event(tx, tenant, row.id, "sale_cancelled", { branchId: row.branch_id, saleId });
  }

  /**
   * Units a customer brought back. Named serials must be from that line; with none named, all of the line's units
   * come back when the whole line does. Units that cannot be sold again are marked damaged.
   */
  async returned(
    tx: DbExecutor,
    tenant: TenantContext,
    input: { saleId: string; saleLineId: string; serials?: string[]; wholeLine: boolean; backToStock: boolean; returnNumber: string },
  ) {
    const sold = rowsOf<SerialRow>(
      await tx.execute(sql`
        SELECT id, serial, status, product_id, branch_id, sale_id, sale_line_id FROM serial_numbers
        WHERE tenant_id = ${tenant.tenantId} AND sale_line_id = ${input.saleLineId} AND status = 'sold' FOR UPDATE`),
    );
    if (sold.length === 0) return;
    let back = sold;
    if (input.serials?.length) {
      const named = new Set(input.serials.map(normalizeSerial));
      back = sold.filter((row) => named.has(row.serial));
      const missing = [...named].filter((serial) => !sold.some((row) => row.serial === serial));
      if (missing.length > 0) throw new ApiError("SERIAL_NOT_ON_SALE", `${missing.join(", ")} was not sold on this line.`, 422, [{ field: "serials", message: "Not sold on this line." }]);
    } else if (!input.wholeLine) {
      return;
    }
    const status = input.backToStock ? "returned" : "damaged";
    for (const row of back) {
      await tx.execute(sql`UPDATE serial_numbers SET status = ${status}, sale_id = NULL, sale_line_id = NULL, customer_id = NULL, updated_at = now() WHERE tenant_id = ${tenant.tenantId} AND id = ${row.id}`);
      await this.event(tx, tenant, row.id, input.backToStock ? "returned" : "returned_damaged", { branchId: row.branch_id, saleId: input.saleId, note: input.returnNumber });
    }
  }

  /** The serial numbers on each of these sale lines, for the sale's page and its receipt. */
  async ofLines(executor: DbExecutor, tenantId: string, lineIds: string[]) {
    const map = new Map<string, string[]>();
    if (lineIds.length === 0) return map;
    const rows = rowsOf<{ sale_line_id: string; serial: string }>(
      await executor.execute(sql`
        SELECT sale_line_id, serial FROM serial_numbers
        WHERE tenant_id = ${tenantId} AND status = 'sold' AND sale_line_id IN (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY serial`),
    );
    for (const row of rows) map.set(row.sale_line_id, [...(map.get(row.sale_line_id) ?? []), row.serial]);
    return map;
  }

  /** Units of a product in a shop that can be sold. */
  async forProduct(tenant: TenantContext, productId: string, branchId?: string) {
    const business = await requireBusiness(this.db, tenant);
    const product = await requireProduct(this.db, tenant, business.id, productId);
    const branch = await resolveBranch(this.db, tenant, business.id, branchId);
    const rows = rowsOf<{ id: string; serial: string; status: string; received_at: string | null }>(
      await this.db.execute(sql`
        SELECT id, serial, status, received_at::text AS received_at FROM serial_numbers
        WHERE tenant_id = ${tenant.tenantId} AND business_id = ${business.id} AND product_id = ${product.id} AND branch_id = ${branch.id}
          AND status IN ('in_stock', 'returned')
        ORDER BY serial LIMIT 500`),
    );
    return { tracksSerials: product.tracksSerials, items: rows.map((row) => ({ id: row.id, serial: row.serial, status: row.status, receivedAt: row.received_at })) };
  }

  /** Finds a unit by its serial number or IMEI (or the start of it), with what happened to it. */
  async lookup(tenant: TenantContext, query: string | undefined) {
    const serial = normalizeSerial(query ?? "");
    if (serial.length < 3) throw new ApiError("VALIDATION_FAILED", "Enter at least 3 characters of the serial number.", 400, [{ field: "q", message: "At least 3 characters." }]);
    const business = await requireBusiness(this.db, tenant);
    const seeCustomer = tenant.permissions.includes(Permission.CUSTOMERS_READ);
    // Staff kept to one shop find the units of that shop only.
    const shop = tenant.membershipBranchId ? sql`AND s.branch_id = ${tenant.membershipBranchId}` : sql``;
    const like = `${serial.replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
    const rows = rowsOf<{
      id: string;
      serial: string;
      status: string;
      product_id: string;
      product_name: string;
      branch_name: string;
      sale_id: string | null;
      sale_number: string | null;
      customer_name: string | null;
      sold_at: string | null;
      received_at: string | null;
    }>(
      await this.db.execute(sql`
        SELECT s.id, s.serial, s.status, s.product_id, p.name AS product_name, b.name AS branch_name, s.sale_id,
          coalesce(sa.sale_number, sa.invoice_number) AS sale_number, c.name AS customer_name, s.sold_at::text AS sold_at, s.received_at::text AS received_at
        FROM serial_numbers s
        JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
        JOIN branches b ON b.tenant_id = s.tenant_id AND b.id = s.branch_id
        LEFT JOIN sales sa ON sa.tenant_id = s.tenant_id AND sa.id = s.sale_id
        LEFT JOIN customers c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
        WHERE s.tenant_id = ${tenant.tenantId} AND s.business_id = ${business.id} AND s.serial LIKE ${like} ${shop}
        ORDER BY (s.serial = ${serial}) DESC, s.serial LIMIT 20`),
    );
    const ids = rows.map((row) => row.id);
    const events = ids.length
      ? rowsOf<{ serial_id: string; event: string; at: string; note: string | null; branch_name: string | null; sale_number: string | null }>(
          await this.db.execute(sql`
            SELECT e.serial_id, e.event, e.at::text AS at, e.note, b.name AS branch_name, coalesce(sa.sale_number, sa.invoice_number) AS sale_number
            FROM serial_number_events e
            LEFT JOIN branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
            LEFT JOIN sales sa ON sa.tenant_id = e.tenant_id AND sa.id = e.sale_id
            WHERE e.tenant_id = ${tenant.tenantId} AND e.serial_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            ORDER BY e.at ASC`),
        )
      : [];
    return {
      items: rows.map((row) => ({
        id: row.id,
        serial: row.serial,
        status: row.status,
        productId: row.product_id,
        productName: row.product_name,
        branchName: row.branch_name,
        saleId: row.sale_id,
        saleNumber: row.sale_number,
        ...(seeCustomer ? { customerName: row.customer_name } : {}),
        soldAt: row.sold_at,
        receivedAt: row.received_at,
        history: events
          .filter((event) => event.serial_id === row.id)
          .map((event) => ({ event: event.event, at: event.at, note: event.note, branchName: event.branch_name, saleNumber: event.sale_number })),
      })),
    };
  }

  private find(tx: DbExecutor, tenantId: string, businessId: string, productId: string, serial: string) {
    return tx
      .execute(sql`
        SELECT id, serial, status, product_id, branch_id, sale_id, sale_line_id FROM serial_numbers
        WHERE tenant_id = ${tenantId} AND business_id = ${businessId} AND product_id = ${productId} AND serial = ${serial} FOR UPDATE`)
      .then((result) => rowsOf<SerialRow>(result));
  }

  private async event(tx: DbExecutor, tenant: TenantContext, serialId: string, event: string, input: { branchId?: string | null; saleId?: string | null; movementId?: string | null; note?: string | null }) {
    await tx.execute(sql`
      INSERT INTO serial_number_events (id, tenant_id, serial_id, event, branch_id, sale_id, movement_id, note, actor_user_id)
      VALUES (${newId()}, ${tenant.tenantId}, ${serialId}, ${event}, ${input.branchId ?? null}, ${input.saleId ?? null}, ${input.movementId ?? null}, ${input.note?.slice(0, 240) ?? null}, ${tenant.userId})`);
  }
}

function quantityWords(quantity: bigint) {
  const units = quantity / 1000n;
  return quantity % 1000n === 0n ? `${units} ${units === 1n ? "unit" : "units"}` : "part of a unit";
}
