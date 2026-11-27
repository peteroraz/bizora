import { Inject, Injectable } from "@nestjs/common";
import {
  capitaliseFirst,
  compactItemKey,
  costEstimateSchema,
  itemAliasSchema,
  matchSaleItems,
  type SaleMatchInput,
  namesFromText,
  Permission,
  productCreateSchema,
  quickImportSchema,
  quickMergeSchema,
  quickUpgradeSchema,
  savedItemKey,
  savedItemRenameSchema,
  SAVED_ITEMS_LIMIT,
  UNIT_CODES,
  businessUnitPatchSchema,
  businessUnitSchema,
  type SavedItem,
} from "@bizora/contracts";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { businessUnits, costEstimates, itemAliases, products, saleLines, savedItems } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireBusiness } from "../inventory/inventory-scope.js";
import { ProductService } from "../inventory/product.service.js";

type ItemRow = typeof savedItems.$inferSelect;

/**
 * Remembered items for a business (ADR-049). A typed or imported name can be sold before it has a price,
 * a unit or stock. Stock starts only when someone asks, and past sales keep the words that were recorded.
 */
@Injectable()
export class QuickCatalogService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProductService) private readonly products: ProductService,
  ) {}

  async list(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const rows = await this.db
      .select()
      .from(savedItems)
      .where(and(eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt)))
      .orderBy(desc(savedItems.timesSold), desc(sql`coalesce(${savedItems.lastSoldAt}, ${savedItems.createdAt})`))
      .limit(SAVED_ITEMS_LIMIT + 1);
    const shown = rows.slice(0, SAVED_ITEMS_LIMIT);
    const aliases = await this.aliasesFor(this.db, tenant.tenantId, business.id, shown.map((row) => row.id));
    const productAliasRows = await this.db
      .select()
      .from(itemAliases)
      .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, business.id), sql`${itemAliases.productId} IS NOT NULL`));
    const units = await this.unitList(tenant, business.id);
    const items: SavedItem[] = shown.map((row) => this.present(row, aliases.get(row.id) ?? []));
    return {
      salesItems: business.salesItems,
      rememberItems: business.rememberItems,
      quickCatalog: business.quickCatalog,
      items,
      productAliases: productAliasRows.map((row) => ({ productId: row.productId as string, alias: row.alias })),
      units,
      truncated: rows.length > SAVED_ITEMS_LIMIT,
    };
  }

  /** What the sales box should offer. Prefix matches come from the index; a short extra pass catches aliases. */
  async suggest(tenant: TenantContext, query: string) {
    const business = await requireBusiness(this.db, tenant);
    const asked = savedItemKey(query);
    if (!asked) {
      const recent = await this.db
        .select()
        .from(savedItems)
        .where(and(eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt), isNull(savedItems.productId)))
        .orderBy(desc(savedItems.lastSoldAt))
        .limit(8);
      return { items: recent.map((row) => ({ ...this.present(row, []), kind: "quick" as const, via: "recent" as const })) };
    }
    const prefix = `${asked}%`;
    const contains = `%${asked}%`;
    const scope = and(eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt));
    const savedRows = await this.db
      .select()
      .from(savedItems)
      .where(and(scope, or(sql`${savedItems.nameKey} LIKE ${prefix}`, sql`${savedItems.nameKey} LIKE ${contains}`)))
      .limit(40);
    const productRows = await this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenant.tenantId),
          eq(products.businessId, business.id),
          isNull(products.archivedAt),
          or(ilike(products.name, `${asked}%`), ilike(products.name, `%${asked}%`), sql`lower(${products.barcode}) = ${asked}`, sql`lower(${products.sku}) = ${asked}`),
        ),
      )
      .limit(40);
    const aliasRows = await this.db
      .select()
      .from(itemAliases)
      .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, business.id), or(sql`${itemAliases.aliasKey} LIKE ${prefix}`, sql`${itemAliases.aliasKey} LIKE ${contains}`)))
      .limit(40);
    const extraSaved = aliasRows.flatMap((row) => (row.savedItemId ? [row.savedItemId] : []));
    const extraProducts = aliasRows.flatMap((row) => (row.productId ? [row.productId] : []));
    const moreSaved = extraSaved.length
      ? await this.db.select().from(savedItems).where(and(scope, inArray(savedItems.id, extraSaved)))
      : [];
    const moreProducts = extraProducts.length
      ? await this.db
          .select()
          .from(products)
          .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, business.id), isNull(products.archivedAt), inArray(products.id, extraProducts)))
      : [];
    const savedById = new Map([...savedRows, ...moreSaved].map((row) => [row.id, row]));
    const productById = new Map([...productRows, ...moreProducts].map((row) => [row.id, row]));
    const aliasBySaved = new Map<string, string[]>();
    const aliasByProduct = new Map<string, string[]>();
    for (const row of aliasRows) {
      if (row.savedItemId) aliasBySaved.set(row.savedItemId, [...(aliasBySaved.get(row.savedItemId) ?? []), row.alias]);
      if (row.productId) aliasByProduct.set(row.productId, [...(aliasByProduct.get(row.productId) ?? []), row.alias]);
    }
    const linked = [...savedById.values()].filter((row) => row.productId);
    const inputs: SaleMatchInput<{ kind: "product"; id: string; name: string; unit: string; lastPriceMinor: string | null; timesSold: number; lastSoldAt: string | null } | (SavedItem & { kind: "quick" })>[] = [
      ...[...productById.values()].map((product) => {
        const memory = linked.find((row) => row.productId === product.id);
        return {
          item: { kind: "product" as const, id: product.id, name: product.name, unit: product.baseUnit, lastPriceMinor: product.priceMinor?.toString() ?? memory?.lastPriceMinor?.toString() ?? null, timesSold: memory?.timesSold ?? 0, lastSoldAt: memory?.lastSoldAt?.toISOString() ?? null },
          name: product.name,
          aliases: aliasByProduct.get(product.id),
          codes: [product.barcode, product.sku],
          timesSold: memory?.timesSold ?? 0,
          lastSoldAt: memory?.lastSoldAt?.toISOString() ?? null,
          managed: true,
        };
      }),
      ...[...savedById.values()]
        .filter((row) => !row.productId)
        .map((row) => ({
          item: { kind: "quick" as const, ...this.present(row, aliasBySaved.get(row.id) ?? []) },
          name: row.name,
          aliases: aliasBySaved.get(row.id),
          timesSold: row.timesSold,
          lastSoldAt: row.lastSoldAt?.toISOString() ?? null,
          managed: false,
        })),
    ];
    const ranked = matchSaleItems(query, inputs, 8);
    return { items: ranked.map((hit) => ({ ...hit.item, via: hit.via })) };
  }

  async importNames(tenant: TenantContext, raw: unknown) {
    const payload = quickImportSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    if (!business.quickCatalog) {
      throw new ApiError("QUICK_CATALOG_OFF", "Adding a list of names is turned off. The owner can turn it on in Settings.", 403);
    }
    const names = [...(payload.names ?? []), ...namesFromText(payload.text ?? "")];
    if (names.length === 0) throw new ApiError("VALIDATION_ERROR", "Add at least one name.", 400);
    if (names.length > 2000) throw new ApiError("VALIDATION_ERROR", "Add up to 2,000 names at a time.", 400);
    const known = await this.knownKeys(this.db, tenant.tenantId, business.id);
    const rows = this.classify(names, known);
    const fresh = rows.filter((row) => row.status === "new");
    if (payload.dryRun !== false) {
      return { dryRun: true, found: rows.length, rows, added: 0 };
    }
    const added: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const row of fresh) {
        const key = savedItemKey(row.name);
        const [inserted] = await tx
          .insert(savedItems)
          .values({
            id: newId(),
            tenantId: tenant.tenantId,
            businessId: business.id,
            name: capitaliseFirst(row.name).slice(0, 160),
            nameKey: key,
            unit: "piece",
            unitSet: false,
            source: "import",
            catalogMode: "quick",
            timesSold: 0,
            createdBy: tenant.userId,
            updatedBy: tenant.userId,
          })
          .onConflictDoNothing({ target: [savedItems.tenantId, savedItems.businessId, savedItems.nameKey] })
          .returning({ id: savedItems.id });
        if (inserted) added.push(row.name);
      }
      if (added.length > 0) {
        await this.audit.record(
          {
            tenantId: tenant.tenantId,
            actorUserId: tenant.userId,
            action: "saved_item.created",
            entityType: "saved_item",
            entityId: business.id,
            correlationId: tenant.correlationId,
            businessId: business.id,
            actorType: tenant.actorType ?? "HUMAN",
            metadata: { source: "import", count: added.length, names: added.slice(0, 20) },
          },
          tx,
        );
      }
    });
    return { dryRun: false, found: rows.length, rows, added: added.length };
  }

  async rename(tenant: TenantContext, id: string, raw: unknown) {
    const payload = savedItemRenameSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const item = await this.requireItem(this.db, tenant, business.id, id);
    const name = payload.name.replace(/\s+/g, " ").trim();
    const key = savedItemKey(name);
    if (!key) throw new ApiError("VALIDATION_ERROR", "Enter a name.", 400, [{ field: "name", message: "Enter a name." }]);
    if (key !== item.nameKey) await this.assertKeyFree(this.db, tenant.tenantId, business.id, key);
    await this.db.update(savedItems).set({ name: name.slice(0, 160), nameKey: key, updatedAt: new Date(), updatedBy: tenant.userId }).where(and(eq(savedItems.id, id), eq(savedItems.tenantId, tenant.tenantId)));
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "saved_item.renamed",
      entityType: "saved_item",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { from: item.name, to: name },
    });
    return { id, name };
  }

  async addAlias(tenant: TenantContext, id: string, raw: unknown) {
    const payload = itemAliasSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const item = await this.requireItem(this.db, tenant, business.id, id);
    const alias = payload.alias.replace(/\s+/g, " ").trim();
    const key = savedItemKey(alias);
    if (!key || key === item.nameKey) throw new ApiError("VALIDATION_ERROR", "That is already the item's name.", 400, [{ field: "alias", message: "Use a different name." }]);
    await this.assertKeyFree(this.db, tenant.tenantId, business.id, key);
    const aliasId = newId();
    await this.db.insert(itemAliases).values({
      id: aliasId,
      tenantId: tenant.tenantId,
      businessId: business.id,
      savedItemId: item.productId ? null : id,
      productId: item.productId,
      alias: capitaliseFirst(alias).slice(0, 160),
      aliasKey: key,
      compactKey: compactItemKey(alias),
      createdBy: tenant.userId,
    });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "saved_item.alias_added",
      entityType: "saved_item",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { alias },
    });
    return { id: aliasId, alias: capitaliseFirst(alias) };
  }

  async removeAlias(tenant: TenantContext, id: string, aliasId: string) {
    const business = await requireBusiness(this.db, tenant);
    const item = await this.requireItem(this.db, tenant, business.id, id);
    const target = item.productId ? eq(itemAliases.productId, item.productId) : eq(itemAliases.savedItemId, item.id);
    const [removed] = await this.db
      .delete(itemAliases)
      .where(and(eq(itemAliases.id, aliasId), eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, business.id), target))
      .returning();
    if (!removed) throw new ApiError("NOT_FOUND", "That other name was not found.", 404);
    return { removed: true };
  }

  async merge(tenant: TenantContext, raw: unknown) {
    const payload = quickMergeSchema.parse(raw);
    if (payload.keepId === payload.dropId) throw new ApiError("VALIDATION_ERROR", "Choose two different items.", 400);
    const business = await requireBusiness(this.db, tenant);
    await this.db.transaction(async (tx) => {
      const keep = await this.requireItem(tx, tenant, business.id, payload.keepId);
      const drop = await this.requireItem(tx, tenant, business.id, payload.dropId);
      if (keep.productId || drop.productId || keep.catalogMode === "managed" || drop.catalogMode === "managed") {
        throw new ApiError("MANAGED_MERGE", "These items track stock. Keep them separate so the stock is not mixed.", 409);
      }
      const dropAliases = await tx.select().from(itemAliases).where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.savedItemId, drop.id)));
      for (const alias of dropAliases) {
        if (alias.aliasKey === keep.nameKey) {
          await tx.delete(itemAliases).where(eq(itemAliases.id, alias.id));
          continue;
        }
        const [taken] = await tx
          .select({ id: itemAliases.id })
          .from(itemAliases)
          .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, business.id), eq(itemAliases.aliasKey, alias.aliasKey)))
          .limit(1);
        if (taken && taken.id !== alias.id) await tx.delete(itemAliases).where(eq(itemAliases.id, alias.id));
        else await tx.update(itemAliases).set({ savedItemId: keep.id }).where(eq(itemAliases.id, alias.id));
      }
      const dropKey = savedItemKey(drop.name);
      if (dropKey && dropKey !== keep.nameKey) {
        const [taken] = await tx
          .select({ id: itemAliases.id })
          .from(itemAliases)
          .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.businessId, business.id), eq(itemAliases.aliasKey, dropKey)))
          .limit(1);
        if (!taken) {
          await tx.insert(itemAliases).values({
            id: newId(),
            tenantId: tenant.tenantId,
            businessId: business.id,
            savedItemId: keep.id,
            alias: drop.name,
            aliasKey: dropKey,
            compactKey: compactItemKey(drop.name),
            createdBy: tenant.userId,
          });
        }
      }
      const later = !keep.lastSoldAt || (drop.lastSoldAt && drop.lastSoldAt > keep.lastSoldAt);
      const first = [keep.firstSoldAt, drop.firstSoldAt].filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      await tx
        .update(savedItems)
        .set({
          timesSold: keep.timesSold + drop.timesSold,
          lastSoldAt: later ? drop.lastSoldAt : keep.lastSoldAt,
          lastPriceMinor: later ? drop.lastPriceMinor : keep.lastPriceMinor,
          unit: later && drop.unitSet ? drop.unit : keep.unit,
          unitSet: keep.unitSet || drop.unitSet,
          firstSoldAt: first,
          updatedAt: new Date(),
          updatedBy: tenant.userId,
        })
        .where(and(eq(savedItems.id, keep.id), eq(savedItems.tenantId, tenant.tenantId)));
      await tx
        .update(savedItems)
        .set({ nameKey: `merged:${drop.id}`, archivedAt: new Date(), updatedAt: new Date(), updatedBy: tenant.userId })
        .where(and(eq(savedItems.id, drop.id), eq(savedItems.tenantId, tenant.tenantId)));
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "saved_item.merged",
          entityType: "saved_item",
          entityId: keep.id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: { kept: keep.name, dropped: drop.name, droppedId: drop.id },
        },
        tx,
      );
    });
    return { keptId: payload.keepId };
  }

  async upgrade(tenant: TenantContext, id: string, raw: unknown) {
    const payload = quickUpgradeSchema.parse(raw);
    if ((payload.costMinor || payload.openingCostMinor) && !tenant.permissions.includes(Permission.PRICES_COST_READ)) {
      throw new ApiError("FORBIDDEN", "You cannot set a cost. Ask the owner.", 403);
    }
    const business = await requireBusiness(this.db, tenant);
    const productId = await this.db.transaction(async (tx) => {
      const item = await this.requireItem(tx, tenant, business.id, id);
      if (item.productId) return item.productId;
      const existing = await this.productByKey(tx, tenant.tenantId, business.id, item.nameKey);
      const created = existing
        ? existing
        : await this.products.createIn(
            tx,
            tenant,
            productCreateSchema.parse({
              name: item.name,
              baseUnit: item.unitSet ? item.unit : "piece",
              ...(payload.priceMinor ? { priceMinor: payload.priceMinor } : item.lastPriceMinor !== null ? { priceMinor: item.lastPriceMinor.toString() } : {}),
              ...(payload.costMinor ? { defaultCostMinor: payload.costMinor } : {}),
              trackStock: payload.trackStock === true,
              itemType: payload.trackStock === true ? "physical" : "non_stock",
              ...(payload.category ? { category: payload.category } : {}),
              ...(payload.sku ? { sku: payload.sku } : {}),
              ...(payload.barcode ? { barcode: payload.barcode } : {}),
              ...(payload.trackStock === true && payload.openingQuantity ? { openingQuantity: payload.openingQuantity, ...(payload.openingCostMinor ? { openingCostMinor: payload.openingCostMinor } : {}) } : {}),
            }),
          );
      await this.link(tx, tenant, item.id, created);
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actorUserId: tenant.userId,
          action: "saved_item.upgraded",
          entityType: "saved_item",
          entityId: item.id,
          correlationId: tenant.correlationId,
          businessId: business.id,
          actorType: tenant.actorType ?? "HUMAN",
          metadata: { productId: created, trackStock: payload.trackStock === true, linked: Boolean(existing) },
        },
        tx,
      );
      return created;
    });
    return { productId };
  }

  async estimateCost(tenant: TenantContext, id: string, raw: unknown) {
    const payload = costEstimateSchema.parse(raw);
    if (!tenant.permissions.includes(Permission.PRICES_COST_READ)) throw new ApiError("FORBIDDEN", "You cannot set a cost. Ask the owner.", 403);
    const business = await requireBusiness(this.db, tenant);
    const item = await this.requireItem(this.db, tenant, business.id, id);
    const estimateId = newId();
    await this.db.insert(costEstimates).values({
      id: estimateId,
      tenantId: tenant.tenantId,
      businessId: business.id,
      savedItemId: item.productId ? null : item.id,
      productId: item.productId,
      estimatedCostMinor: BigInt(payload.estimatedCostMinor),
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      reason: payload.reason,
      createdBy: tenant.userId,
    });
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "saved_item.cost_estimated",
      entityType: "saved_item",
      entityId: item.id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { estimatedCostMinor: payload.estimatedCostMinor, periodStart: payload.periodStart, periodEnd: payload.periodEnd },
    });
    return { id: estimateId };
  }

  async remove(tenant: TenantContext, id: string) {
    const business = await requireBusiness(this.db, tenant);
    const [removed] = await this.db
      .update(savedItems)
      .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: tenant.userId })
      .where(and(eq(savedItems.id, id), eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, business.id), isNull(savedItems.archivedAt)))
      .returning();
    if (!removed) throw new ApiError("NOT_FOUND", "That saved item was not found.", 404);
    await this.audit.record({
      tenantId: tenant.tenantId,
      actorUserId: tenant.userId,
      action: "saved_item.removed",
      entityType: "saved_item",
      entityId: id,
      correlationId: tenant.correlationId,
      businessId: business.id,
      actorType: tenant.actorType ?? "HUMAN",
      metadata: { name: removed.name },
    });
    return { removed: true };
  }

  async units(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    return { units: await this.unitList(tenant, business.id) };
  }

  async addUnit(tenant: TenantContext, raw: unknown) {
    const payload = businessUnitSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    if ((UNIT_CODES as readonly string[]).includes(payload.code)) {
      throw new ApiError("UNIT_EXISTS", "That unit is already in the list.", 409, [{ field: "code", message: "Already there." }]);
    }
    const id = newId();
    const [inserted] = await this.db
      .insert(businessUnits)
      .values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        code: payload.code,
        displayName: payload.displayName,
        pluralName: payload.pluralName ?? null,
        standard: false,
        createdBy: tenant.userId,
      })
      .onConflictDoNothing({ target: [businessUnits.tenantId, businessUnits.businessId, businessUnits.code] })
      .returning();
    if (!inserted) {
      const [existing] = await this.db
        .select()
        .from(businessUnits)
        .where(and(eq(businessUnits.tenantId, tenant.tenantId), eq(businessUnits.businessId, business.id), eq(businessUnits.code, payload.code)))
        .limit(1);
      if (existing && !existing.active) {
        const [revived] = await this.db
          .update(businessUnits)
          .set({ active: true, displayName: payload.displayName, pluralName: payload.pluralName ?? existing.pluralName })
          .where(and(eq(businessUnits.id, existing.id), eq(businessUnits.tenantId, tenant.tenantId)))
          .returning();
        if (revived) {
          return { unit: { id: revived.id, code: revived.code, displayName: revived.displayName, pluralName: revived.pluralName, standard: false, active: true } };
        }
      }
      throw new ApiError("UNIT_EXISTS", "That unit is already in the list.", 409, [{ field: "code", message: "Already there." }]);
    }
    return { unit: { id, code: payload.code, displayName: payload.displayName, pluralName: payload.pluralName ?? null, standard: false, active: true } };
  }

  async patchUnit(tenant: TenantContext, id: string, raw: unknown) {
    const payload = businessUnitPatchSchema.parse(raw);
    const business = await requireBusiness(this.db, tenant);
    const [current] = await this.db
      .select()
      .from(businessUnits)
      .where(and(eq(businessUnits.id, id), eq(businessUnits.tenantId, tenant.tenantId), eq(businessUnits.businessId, business.id)))
      .limit(1);
    if (!current) throw new ApiError("NOT_FOUND", "That unit was not found.", 404);
    if (payload.active === false) {
      const [used] = await this.db
        .select({ id: saleLines.id })
        .from(saleLines)
        .where(and(eq(saleLines.tenantId, tenant.tenantId), eq(saleLines.businessId, business.id), eq(saleLines.enteredUnit, current.code)))
        .limit(1);
      if (used) throw new ApiError("UNIT_IN_USE", "This unit is on a sale, so it stays in the list.", 409);
    }
    const changes = {
      ...(payload.displayName ? { displayName: payload.displayName } : {}),
      ...(payload.pluralName !== undefined ? { pluralName: payload.pluralName || null } : {}),
      ...(payload.active !== undefined ? { active: payload.active } : {}),
    };
    if (Object.keys(changes).length === 0) throw new ApiError("VALIDATION_ERROR", "Say what to change.", 400);
    const [updated] = await this.db
      .update(businessUnits)
      .set(changes)
      .where(and(eq(businessUnits.id, id), eq(businessUnits.tenantId, tenant.tenantId), eq(businessUnits.businessId, business.id)))
      .returning();
    if (!updated) throw new ApiError("NOT_FOUND", "That unit was not found.", 404);
    return { unit: { id: updated.id, code: updated.code, displayName: updated.displayName, pluralName: updated.pluralName, standard: updated.standard, active: updated.active } };
  }

  private present(row: ItemRow, aliases: string[]): SavedItem {
    return {
      id: row.id,
      name: row.name,
      unit: row.unit,
      lastPriceMinor: row.lastPriceMinor?.toString() ?? null,
      timesSold: row.timesSold,
      lastSoldAt: row.lastSoldAt?.toISOString() ?? null,
      firstSoldAt: row.firstSoldAt?.toISOString() ?? null,
      source: row.source,
      catalogMode: row.catalogMode === "managed" ? "managed" : "quick",
      productId: row.productId,
      unitSet: row.unitSet,
      aliases,
    };
  }

  private async aliasesFor(db: DbExecutor, tenantId: string, businessId: string, ids: string[]) {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await db
      .select()
      .from(itemAliases)
      .where(and(eq(itemAliases.tenantId, tenantId), eq(itemAliases.businessId, businessId), inArray(itemAliases.savedItemId, ids)));
    for (const row of rows) {
      if (!row.savedItemId) continue;
      map.set(row.savedItemId, [...(map.get(row.savedItemId) ?? []), row.alias]);
    }
    return map;
  }

  private async unitList(tenant: TenantContext, businessId: string) {
    const custom = await this.db
      .select()
      .from(businessUnits)
      .where(and(eq(businessUnits.tenantId, tenant.tenantId), eq(businessUnits.businessId, businessId), eq(businessUnits.active, true)));
    const standard = UNIT_CODES.map((code) => ({ code, displayName: capitaliseFirst(code), pluralName: null as string | null, standard: true, active: true }));
    const extra = custom
      .filter((unit) => !(UNIT_CODES as readonly string[]).includes(unit.code))
      .map((unit) => ({ id: unit.id, code: unit.code, displayName: unit.displayName, pluralName: unit.pluralName, standard: false, active: unit.active }));
    return [...standard, ...extra];
  }

  private classify(names: string[], known: Set<string>) {
    const seen = new Set<string>();
    const rows: { name: string; status: "new" | "exists" | "invalid"; reason?: string }[] = [];
    for (const raw of names) {
      const name = raw.trim().replace(/\s+/g, " ");
      const key = savedItemKey(name);
      if (!key || name.length > 160) {
        rows.push({ name: name || raw, status: "invalid", reason: "Use a name of 160 characters or fewer." });
        continue;
      }
      if (seen.has(key)) {
        rows.push({ name, status: "exists", reason: "Already in this list." });
        continue;
      }
      seen.add(key);
      if (known.has(key)) {
        rows.push({ name, status: "exists", reason: "Already in your products." });
        continue;
      }
      rows.push({ name, status: "new" });
    }
    return rows;
  }

  private async knownKeys(db: DbExecutor, tenantId: string, businessId: string) {
    const [saved, goods, aliases] = await Promise.all([
      db.select({ key: savedItems.nameKey }).from(savedItems).where(and(eq(savedItems.tenantId, tenantId), eq(savedItems.businessId, businessId))),
      db.select({ name: products.name }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt))),
      db.select({ key: itemAliases.aliasKey }).from(itemAliases).where(and(eq(itemAliases.tenantId, tenantId), eq(itemAliases.businessId, businessId))),
    ]);
    return new Set([...saved.map((row) => row.key), ...goods.map((row) => savedItemKey(row.name)), ...aliases.map((row) => row.key)]);
  }

  private async assertKeyFree(db: DbExecutor, tenantId: string, businessId: string, key: string) {
    const known = await this.knownKeys(db, tenantId, businessId);
    if (known.has(key)) throw new ApiError("NAME_TAKEN", "Something with that name is already in the list.", 409, [{ field: "name", message: "Already used." }]);
  }

  private async requireItem(db: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [row] = await db
      .select()
      .from(savedItems)
      .where(and(eq(savedItems.id, id), eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, businessId), isNull(savedItems.archivedAt)))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "That item was not found.", 404);
    return row;
  }

  /** Points a remembered item, and its other names, at a product (ADR-049 upgrade). */
  private async link(tx: DbExecutor, tenant: TenantContext, savedItemId: string, productId: string) {
    await tx
      .update(savedItems)
      .set({ productId, catalogMode: "managed", updatedAt: new Date(), updatedBy: tenant.userId })
      .where(and(eq(savedItems.id, savedItemId), eq(savedItems.tenantId, tenant.tenantId)));
    await tx
      .update(itemAliases)
      .set({ productId, savedItemId: null })
      .where(and(eq(itemAliases.tenantId, tenant.tenantId), eq(itemAliases.savedItemId, savedItemId)));
  }

  /**
   * A product just added from imported sales takes over the remembered item with the same name, if there is one, so
   * the sale screen offers one thing, not two (ADR-074).
   */
  async linkByName(tx: DbExecutor, tenant: TenantContext, businessId: string, name: string, productId: string) {
    const [item] = await tx
      .select({ id: savedItems.id })
      .from(savedItems)
      .where(and(eq(savedItems.tenantId, tenant.tenantId), eq(savedItems.businessId, businessId), eq(savedItems.nameKey, savedItemKey(name)), isNull(savedItems.productId)))
      .limit(1);
    if (item) await this.link(tx, tenant, item.id, productId);
  }

  private async productByKey(db: DbExecutor, tenantId: string, businessId: string, key: string) {
    const rows = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.businessId, businessId), isNull(products.archivedAt), sql`lower(${products.name}) LIKE ${`${key.slice(0, 80)}%`}`))
      .limit(30);
    return rows.find((row) => savedItemKey(row.name) === key)?.id ?? null;
  }
}
