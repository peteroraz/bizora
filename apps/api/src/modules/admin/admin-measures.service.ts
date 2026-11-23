import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { DB } from "../../tokens.js";

type Row = Record<string, unknown>;
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
/** Postgres writes times as "2026-11-23 02:08:38.95+00"; the portal gets ISO 8601. */
const text = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};
const count = (value: unknown) => Number(value ?? 0);

/** Event names counted for each business in the pilot measures. */
const COUNTED = [
  "sync.applied",
  "sync.duplicate",
  "sync.rejected",
  "voice.download_started",
  "voice.download_finished",
  "voice.download_failed",
  "voice.download_cancelled",
  "voice.review_shown",
  "voice.sale_confirmed",
  "voice.review_closed",
  "voice.read_failed",
  "voice.typed_used",
] as const;

/**
 * Pilot measures for Bizora staff (ADR-045): counts per business, from the records themselves and from pilot events.
 * No names of customers, no amounts per sale, nothing anyone typed. Sale value is a total per currency, in minor units.
 */
@Injectable()
export class AdminMeasuresService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async overview(rawDays: unknown) {
    const days = Math.min(90, Math.max(1, Number.parseInt(String(rawDays ?? "14"), 10) || 14));
    const since = new Date(Date.now() - days * 86_400_000);
    // Times go to the database as text: the postgres driver does not take Date objects in raw queries.
    const sinceText = since.toISOString();
    const businesses = rowsOf(
      await this.db.execute(sql`
        SELECT o.id, o.name, o.is_sample, o.created_at::text AS created_at,
          (SELECT max(s.last_used_at)::text FROM sessions s WHERE s.tenant_id = o.id) AS last_active,
          (SELECT count(DISTINCT s.membership_id) FROM sessions s WHERE s.tenant_id = o.id AND s.last_used_at >= ${sinceText}::timestamptz) AS people_active,
          (SELECT count(*) FROM sales x WHERE x.tenant_id = o.id AND x.created_at >= ${sinceText}::timestamptz AND NOT x.history_only) AS sales,
          (SELECT count(*) FROM sales x WHERE x.tenant_id = o.id AND x.created_at >= ${sinceText}::timestamptz AND NOT x.history_only AND x.source = 'offline') AS offline_sales,
          (SELECT count(*) FROM sales x WHERE x.tenant_id = o.id AND x.voided_at >= ${sinceText}::timestamptz) AS voided_sales,
          (SELECT count(*) FROM sales x WHERE x.tenant_id = o.id AND x.created_at >= ${sinceText}::timestamptz AND x.balance_minor > 0) AS credit_sales,
          (SELECT count(*) FROM customer_payments p WHERE p.tenant_id = o.id AND p.created_at >= ${sinceText}::timestamptz) AS debt_payments,
          (SELECT count(*) FROM customers c WHERE c.tenant_id = o.id AND c.archived_at IS NULL) AS customers,
          o.onboarding_completed_at::text AS onboarded_at,
          (SELECT min(p.created_at)::text FROM products p WHERE p.tenant_id = o.id) AS first_product_at,
          (SELECT min(m.created_at)::text FROM stock_movements m WHERE m.tenant_id = o.id) AS first_stock_at,
          (SELECT min(x.created_at)::text FROM sales x WHERE x.tenant_id = o.id AND NOT x.history_only) AS first_sale_at,
          (SELECT min(x.created_at)::text FROM sales x WHERE x.tenant_id = o.id AND NOT x.history_only AND (x.due_date IS NOT NULL OR x.balance_minor > 0)) AS first_credit_sale_at,
          (SELECT min(p.created_at)::text FROM customer_payments p WHERE p.tenant_id = o.id) AS first_debt_payment_at,
          (SELECT min(x.created_at)::text FROM sales x WHERE x.tenant_id = o.id AND x.source = 'offline') AS first_offline_sale_at
        FROM organizations o
        ORDER BY o.created_at DESC`),
    );
    const events = rowsOf(
      await this.db.execute(sql`
        SELECT tenant_id, event, count(*) AS total FROM pilot_events WHERE occurred_at >= ${sinceText}::timestamptz GROUP BY tenant_id, event`),
    );
    const values = rowsOf(
      await this.db.execute(sql`
        SELECT tenant_id, currency_code, sum(total_minor)::text AS total_minor FROM sales
        WHERE created_at >= ${sinceText}::timestamptz AND NOT history_only AND voided_at IS NULL GROUP BY tenant_id, currency_code`),
    );
    const rows = businesses.map((business) => {
      const id = String(business.id);
      const counted = Object.fromEntries(COUNTED.map((name) => [name, count(events.find((event) => event.tenant_id === id && event.event === name)?.total)]));
      return {
        id,
        name: String(business.name),
        sample: business.is_sample === true,
        createdAt: text(business.created_at),
        lastActive: text(business.last_active),
        peopleActive: count(business.people_active),
        sales: count(business.sales),
        offlineSales: count(business.offline_sales),
        voidedSales: count(business.voided_sales),
        creditSales: count(business.credit_sales),
        debtPayments: count(business.debt_payments),
        customers: count(business.customers),
        firstSteps: {
          registered: text(business.created_at),
          onboarded: text(business.onboarded_at),
          product: text(business.first_product_at),
          stock: text(business.first_stock_at),
          sale: text(business.first_sale_at),
          creditSale: text(business.first_credit_sale_at),
          debtPayment: text(business.first_debt_payment_at),
          offlineSale: text(business.first_offline_sale_at),
        },
        salesValue: values.filter((value) => value.tenant_id === id).map((value) => ({ currency: String(value.currency_code).trim(), totalMinor: String(value.total_minor) })),
        events: counted,
      };
    });
    const real = rows.filter((row) => !row.sample);
    const reached = (step: keyof (typeof rows)[number]["firstSteps"]) => real.filter((row) => row.firstSteps[step] !== null).length;
    const sinceTime = since.getTime();
    return {
      days,
      since: since.toISOString(),
      totals: {
        businesses: real.length,
        activeBusinesses: real.filter((row) => row.sales > 0 || row.peopleActive > 0).length,
        sales: real.reduce((sum, row) => sum + row.sales, 0),
        offlineSales: real.reduce((sum, row) => sum + row.offlineSales, 0),
        syncRejected: real.reduce((sum, row) => sum + (row.events["sync.rejected"] ?? 0), 0),
        voiceConfirmed: real.reduce((sum, row) => sum + (row.events["voice.sale_confirmed"] ?? 0), 0),
        voiceShown: real.reduce((sum, row) => sum + (row.events["voice.review_shown"] ?? 0), 0),
        voiceDownloadsFailed: real.reduce((sum, row) => sum + (row.events["voice.download_failed"] ?? 0), 0),
        registeredInPeriod: real.filter((row) => row.createdAt !== null && new Date(row.createdAt).getTime() >= sinceTime).length,
      },
      /** How many real businesses have ever reached each first step (not limited to the period). */
      firstSteps: {
        registered: real.length,
        onboarded: reached("onboarded"),
        product: reached("product"),
        stock: reached("stock"),
        sale: reached("sale"),
        creditSale: reached("creditSale"),
        debtPayment: reached("debtPayment"),
        offlineSale: reached("offlineSale"),
      },
      // Totals count every business; the list shows the 500 newest.
      businesses: rows.slice(0, 500),
    };
  }

  /** For support: what went wrong for one business lately. Refusal codes and times only. */
  async health(tenantId: string) {
    const [organization] = rowsOf(await this.db.execute(sql`SELECT id FROM organizations WHERE id = ${tenantId}`));
    if (!organization) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const sinceText = since.toISOString();
    const refusals = rowsOf(
      await this.db.execute(sql`
        SELECT detail, count(*) AS total, max(occurred_at)::text AS last_at FROM pilot_events
        WHERE tenant_id = ${tenantId} AND event = 'sync.rejected' AND occurred_at >= ${sinceText}::timestamptz GROUP BY detail ORDER BY max(occurred_at) DESC LIMIT 20`),
    );
    const problems = rowsOf(
      await this.db.execute(sql`
        SELECT event, detail, count(*) AS total, max(occurred_at)::text AS last_at FROM pilot_events
        WHERE tenant_id = ${tenantId} AND event IN ('voice.download_failed', 'voice.read_failed') AND occurred_at >= ${sinceText}::timestamptz
        GROUP BY event, detail ORDER BY max(occurred_at) DESC LIMIT 20`),
    );
    const [sessions] = rowsOf(
      await this.db.execute(sql`
        SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) AS open_sessions,
          count(DISTINCT device_id) FILTER (WHERE revoked_at IS NULL AND expires_at > now() AND device_id IS NOT NULL) AS shop_devices,
          max(last_used_at)::text AS last_active
        FROM sessions WHERE tenant_id = ${tenantId}`),
    );
    const [synced] = rowsOf(await this.db.execute(sql`SELECT max(occurred_at)::text AS last_sync FROM pilot_events WHERE tenant_id = ${tenantId} AND event = 'sync.applied'`));
    return {
      since: since.toISOString(),
      lastActive: text(sessions?.last_active),
      lastSync: text(synced?.last_sync),
      openSessions: count(sessions?.open_sessions),
      shopDevicesSignedIn: count(sessions?.shop_devices),
      syncRefusals: refusals.map((row) => ({ code: text(row.detail), total: count(row.total), lastAt: text(row.last_at) })),
      voiceProblems: problems.map((row) => ({ event: String(row.event), code: text(row.detail), total: count(row.total), lastAt: text(row.last_at) })),
    };
  }
}
