import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { zip } from "../../common/zip.js";
import type { AppDatabase } from "../../db/database.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";

type Row = Record<string, string | null>;
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];

/**
 * What goes into the export, file by file. Only these tables, and from them only this business's rows. Columns that
 * are secrets or links (`*_token`, `*_hash`), sign-in details (`ip`, `user_agent`) and pictures (bytea) are left out.
 */
const FILES: { file: string; table: string; order?: string }[] = [
  { file: "businesses", table: "businesses" },
  { file: "shops", table: "branches" },
  { file: "addresses", table: "addresses" },
  { file: "customers", table: "customers" },
  { file: "customer_notes", table: "customer_notes" },
  { file: "customer_followups", table: "customer_followups" },
  { file: "products", table: "products" },
  { file: "product_units", table: "product_units" },
  { file: "saved_items", table: "saved_items" },
  { file: "stock_levels", table: "stock_balances", order: "branch_id, product_id" },
  { file: "stock_movements", table: "stock_movements" },
  { file: "stock_counts", table: "stock_counts" },
  { file: "stock_requests", table: "stock_requests" },
  { file: "sales", table: "sales" },
  { file: "sale_lines", table: "sale_lines" },
  { file: "sale_payments", table: "sale_payments" },
  { file: "sale_comments", table: "sale_comments" },
  { file: "returns", table: "sale_returns" },
  { file: "return_lines", table: "sale_return_lines" },
  { file: "debt_payments", table: "customer_payments" },
  { file: "debt_payment_allocations", table: "payment_allocations" },
  { file: "expenses", table: "expenses" },
  { file: "money_movements", table: "money_movements" },
  { file: "cash_counts", table: "cash_counts" },
  { file: "suppliers", table: "suppliers" },
  { file: "supplier_entries", table: "supplier_entries" },
  { file: "jobs", table: "jobs" },
  { file: "job_lines", table: "job_lines" },
  { file: "bank_statement_lines", table: "statement_lines" },
  { file: "accounts", table: "ledger_accounts" },
  { file: "journal_entries", table: "journal_entries" },
  { file: "journal_lines", table: "journal_lines" },
  { file: "activity_log", table: "audit_events" },
];

const LEFT_OUT = /(_token|_hash)$|^(ip|user_agent|data)$/;
const TEXT_TYPES = new Set(["text", "character varying", "character", "jsonb", "json", "ARRAY"]);
/** Spreadsheets run a cell that starts with these as a formula; a leading ' stops that. */
const FORMULA_START = /^[=+\-@\t\r]/;
const MAX_ROWS = 500_000;

const README = `Bizora business records export
==============================

Made: {made}
Business: {name}

Each .csv file is one kind of record, with one row per record. Open them in Excel, Google Sheets or LibreOffice.

Money
-----
Columns ending in _minor are amounts in the smallest unit of the currency in currency_code:
kobo for naira (100 kobo = NGN 1), cents for dollars. For example 150000 in NGN is NGN 1,500.00.
They are whole numbers on purpose, so nothing is lost to rounding.

Quantities
----------
quantity and similar columns are in the product's smallest unit, times 1000 (so 2500 means 2.5).
entered_quantity (also times 1000) and entered_unit show what was typed at the time.

Dates and times
---------------
Times include their offset from UTC (+00 is UTC). Dates are YYYY-MM-DD.

IDs
---
Columns ending in _id link records together: sale_lines.sale_id is sales.id.

Left out
--------
Passwords, PINs, sign-in links and tokens, receipt and statement links, sign-in addresses,
and pictures (product photos and the logo) are not in this export.

Text that starts with = + - or @ has a ' added in front, so a spreadsheet does not run it as a formula.

Accounting
----------
journal_entries and journal_lines are the double-entry books behind every sale, payment and expense.
Each entry's debit_minor total equals its credit_minor total.
`;

/** Every record of one business, as CSV files in a ZIP (pilot readiness, item 14). Owner and administrators only. */
@Injectable()
export class BusinessExportService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async build(tenant: TenantContext, now = new Date()) {
    const columns = rowsOf(
      await this.db.execute(sql`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN (${sql.join(FILES.map((entry) => sql`${entry.table}`), sql`, `)})
        ORDER BY table_name, ordinal_position`),
    );
    const files: { name: string; data: Buffer }[] = [];
    const counts: Record<string, number> = {};
    let total = 0;
    for (const entry of FILES) {
      const wanted = columns.filter((column) => column.table_name === entry.table && !LEFT_OUT.test(String(column.column_name)) && column.data_type !== "bytea");
      if (!wanted.some((column) => column.column_name === "tenant_id")) continue;
      const names = wanted.map((column) => String(column.column_name));
      const select = sql.join(names.map((name) => sql.raw(`${quote(name)}::text AS ${quote(name)}`)), sql`, `);
      const order = sql.raw(entry.order ?? (names.includes("id") ? "id" : names[1] ?? "tenant_id"));
      const rows = rowsOf(await this.db.execute(sql`SELECT ${select} FROM ${sql.raw(quote(entry.table))} WHERE tenant_id = ${tenant.tenantId} ORDER BY ${order} LIMIT ${MAX_ROWS + 1}`));
      if (rows.length > MAX_ROWS) throw new ApiError("EXPORT_TOO_BIG", "This business has too many records to download at once. Contact Bizora support.", 413);
      const textual = new Set(wanted.filter((column) => TEXT_TYPES.has(String(column.data_type))).map((column) => String(column.column_name)));
      files.push({ name: `${entry.file}.csv`, data: Buffer.from(toCsv(names, rows, textual), "utf8") });
      counts[entry.file] = rows.length;
      total += rows.length;
    }
    const [organization] = rowsOf(await this.db.execute(sql`SELECT name, handle FROM organizations WHERE id = ${tenant.tenantId}`));
    const made = now.toISOString();
    files.unshift({ name: "README.txt", data: Buffer.from(README.replace("{made}", made).replace("{name}", organization?.name ?? ""), "utf8") });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "business.exported",
      entityType: "organization",
      entityId: tenant.tenantId,
      correlationId: tenant.correlationId,
      metadata: { files: files.length, records: total },
    });
    const handle = String(organization?.handle ?? "business").replace(/[^a-z0-9-]/g, "");
    return { fileName: `bizora-${handle}-${made.slice(0, 10)}.zip`, data: zip(files, now), counts };
  }
}

function quote(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`unexpected identifier ${identifier}`);
  return `"${identifier}"`;
}

/** RFC 4180 CSV, with a byte-order mark so Excel reads UTF-8 (₦, names in other scripts) correctly. */
export function toCsv(names: string[], rows: Row[], textual: Set<string>) {
  const cell = (name: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return "";
    const safe = textual.has(name) && FORMULA_START.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [names.join(","), ...rows.map((row) => names.map((name) => cell(name, row[name])).join(","))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
