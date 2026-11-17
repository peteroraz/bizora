import { Inject, Injectable, Logger } from "@nestjs/common";
import { CAPTURE_FIELDS, CAPTURE_MAX_ROWS, Permission, captureRequestSchema, type CaptureResult, type CaptureTarget } from "@bizora/contracts";
import type { AppEnv } from "@bizora/config/env";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { TenantContext } from "../../common/tenant-context.js";
import { localDate } from "../../common/zoned-day.js";
import type { AppDatabase } from "../../db/database.js";
import { aiUsage, products } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness } from "../inventory/inventory-scope.js";
import { CAPTURE_MODEL, type CaptureModel } from "./capture-model.js";

/** Who may capture what: the same people who may import it. */
const TARGET_PERMISSION: Record<CaptureTarget, string> = {
  products: Permission.PRODUCTS_MANAGE,
  sales: Permission.SALES_CREATE,
  stock_in: Permission.STOCK_RECEIVE,
  statement: Permission.BANK_RECONCILE,
};

const TIMEOUT_MS = 90_000;
const MAX_CELL = 200;
const MAX_PRODUCT_NAMES = 400;

/**
 * AI capture (ADR-018). Photos, scans and voice notes go to the model and come back as draft rows for the review
 * table. Capture never saves business data: a person checks the rows and saves them through the import endpoints.
 * The model's answer is treated as untrusted text: only known fields survive, as short strings.
 */
@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CAPTURE_MODEL) private readonly model: CaptureModel | null,
  ) {}

  private get limit() {
    return this.env.AI_DAILY_CAPTURE_LIMIT ?? 50;
  }

  async status(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const used = await this.used(tenant.tenantId, localDate(new Date(), business.timezone));
    return {
      enabled: this.model !== null && this.limit > 0,
      limit: this.limit,
      remainingToday: Math.max(0, this.limit - used),
      targets: (Object.keys(TARGET_PERMISSION) as CaptureTarget[]).filter((target) => tenant.permissions.includes(TARGET_PERMISSION[target] as never)),
    };
  }

  async capture(tenant: TenantContext, raw: unknown): Promise<CaptureResult> {
    const payload = captureRequestSchema.parse(raw);
    if (!tenant.permissions.includes(TARGET_PERMISSION[payload.target] as never)) {
      throw new ApiError("FORBIDDEN", "You cannot add these records.", 403);
    }
    if (!this.model || this.limit === 0) throw new ApiError("AI_OFF", "Reading photos and voice notes is not switched on for this organization.", 503);
    const business = await requireBusiness(this.db, tenant);
    const today = localDate(new Date(), business.timezone);
    const bytes = payload.files.reduce((sum, file) => sum + Math.floor((file.data.length * 3) / 4), 0);

    // Count the capture before calling the model, so parallel requests cannot go over the limit.
    const [usage] = await this.db
      .insert(aiUsage)
      .values({ tenantId: tenant.tenantId, day: today, captures: 1, inputBytes: BigInt(bytes) })
      .onConflictDoUpdate({
        target: [aiUsage.tenantId, aiUsage.day],
        set: { captures: sql`${aiUsage.captures} + 1`, inputBytes: sql`${aiUsage.inputBytes} + ${bytes}`, updatedAt: new Date() },
        where: sql`${aiUsage.captures} < ${this.limit}`,
      })
      .returning({ captures: aiUsage.captures });
    if (!usage) throw new ApiError("AI_LIMIT", `Your organization has used all ${this.limit} photo and voice reads for today. Try again tomorrow, or type the rows.`, 429);

    const productNames = (
      await this.db
        .select({ name: products.name })
        .from(products)
        .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt)))
        .orderBy(asc(products.name))
        .limit(MAX_PRODUCT_NAMES)
    ).map((row) => row.name);
    const fields = CAPTURE_FIELDS[payload.target];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let answer: unknown;
    try {
      answer = await this.model.extract(
        { target: payload.target, fields, files: payload.files, note: payload.note, today, productNames, currency: business.baseCurrencyCode.trim() },
        controller.signal,
      );
    } catch (error) {
      // Content is never logged, only that the call failed.
      this.logger.warn(`Capture failed for tenant ${tenant.tenantId}: ${error instanceof Error ? error.name : "error"}`);
      throw new ApiError("AI_FAILED", "The photo or voice note could not be read just now. Try again, or type the rows.", 502);
    } finally {
      clearTimeout(timer);
    }
    const result = sanitize(answer, fields);

    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "capture.drafted",
      entityType: "capture",
      entityId: null,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: "AI_AGENT",
      metadata: {
        target: payload.target,
        model: this.model.name,
        files: payload.files.map((file) => file.mimeType),
        rows: result.rows.length,
        warnings: result.warnings.length,
      },
    });
    return { target: payload.target, ...result, remainingToday: Math.max(0, this.limit - usage.captures) };
  }

  private async used(tenantId: string, day: string) {
    const [row] = await this.db
      .select({ captures: aiUsage.captures })
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, tenantId), eq(aiUsage.day, day)))
      .limit(1);
    return row?.captures ?? 0;
  }
}

/**
 * Keeps only what the review table can show: known fields as short single-line strings, at most CAPTURE_MAX_ROWS
 * rows, with empty rows dropped. Anything else in the model's answer is ignored.
 */
export function sanitize(answer: unknown, fields: readonly string[]): Pick<CaptureResult, "rows" | "warnings" | "transcript"> {
  const object = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const cell = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value !== "string") return "";
    // Control characters (new lines, tabs and the like) become spaces, so every value is one line.
    const oneLine = Array.from(value, (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("");
    return oneLine.replace(/\s+/g, " ").trim().slice(0, MAX_CELL);
  };
  const rows = (Array.isArray(object.rows) ? object.rows : [])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => Object.fromEntries(fields.map((field) => [field, cell(row[field])])))
    .filter((row) => Object.values(row).some((value) => value !== ""))
    .slice(0, CAPTURE_MAX_ROWS);
  const warnings = (Array.isArray(object.warnings) ? object.warnings : [])
    .map((warning) => cell(warning))
    .filter(Boolean)
    .slice(0, 10);
  const transcript = typeof object.transcript === "string" && object.transcript.trim() ? object.transcript.trim().slice(0, 4000) : null;
  if (Array.isArray(object.rows) && object.rows.length > CAPTURE_MAX_ROWS) warnings.push(`Only the first ${CAPTURE_MAX_ROWS} rows were kept. Capture the rest separately.`);
  return { rows, warnings, transcript };
}
