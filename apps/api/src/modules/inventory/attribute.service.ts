import { Inject, Injectable } from "@nestjs/common";
import {
  attributeCreateSchema,
  attributeUpdateSchema,
  combinations,
  generateVariantsSchema,
  nameKey,
  VARIANT_GENERATION_MAX,
  variantAttributesSchema,
  variantName,
  type AttributeKind,
} from "@bizora/contracts";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ZodType } from "zod";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { attributeDefinitions, attributeOptions, products, variantAttributeValues } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { requireItem } from "./catalog-scope.js";
import { requireBusiness } from "./inventory-scope.js";
import { ProductService } from "./product.service.js";

type Definition = typeof attributeDefinitions.$inferSelect;
type Option = typeof attributeOptions.$inferSelect;

function parse<T>(schema: ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw new ApiError(
    "VALIDATION_ERROR",
    message,
    400,
    result.error.issues.map((issue) => ({ field: issue.path.join(".") || "body", message: issue.message })),
  );
}

/**
 * Product attributes (ADR-060). A business defines its own (Colour, Size, Storage, Make…), not fixed columns on the
 * product. A list attribute has choices; a variant holds one value per attribute (several for a multi-select). The
 * choices can make variants: one per combination, named "Polo shirt Red / M", each its own stock and price.
 */
@Injectable()
export class AttributeService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(ProductService) private readonly products: ProductService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext) {
    const business = await requireBusiness(this.db, tenant);
    const definitions = await this.db
      .select()
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenant.tenantId), eq(attributeDefinitions.businessId, business.id)))
      .orderBy(asc(attributeDefinitions.position), asc(attributeDefinitions.nameKey));
    const options = definitions.length
      ? await this.db
          .select()
          .from(attributeOptions)
          .where(and(eq(attributeOptions.tenantId, tenant.tenantId), inArray(attributeOptions.attributeId, definitions.map((definition) => definition.id))))
          .orderBy(asc(attributeOptions.position), asc(attributeOptions.valueKey))
      : [];
    return { items: definitions.map((definition) => this.present(definition, options.filter((option) => option.attributeId === definition.id))) };
  }

  async create(tenant: TenantContext, raw: unknown) {
    const payload = parse(attributeCreateSchema, raw, "Check the attribute.");
    const id = newId();
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      await this.assertNameFree(tx, tenant, business.id, nameKey(payload.name));
      await tx.insert(attributeDefinitions).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        name: payload.name.replace(/\s+/g, " "),
        nameKey: nameKey(payload.name),
        kind: payload.kind ?? "select",
        unit: payload.kind === "number" ? (payload.unit?.trim() || null) : null,
        position: payload.position ?? 0,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      });
      await this.addOptions(tx, tenant, business.id, id, payload.options ?? []);
      await this.record(tx, tenant, business.id, "attribute.created", id, { name: payload.name, kind: payload.kind, options: payload.options ?? [] });
    });
    return this.one(tenant, id);
  }

  async update(tenant: TenantContext, id: string, raw: unknown) {
    const payload = parse(attributeUpdateSchema, raw, "Check the attribute.");
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const existing = await this.requireDefinition(tx, tenant, business.id, id);
      const changes: Partial<typeof attributeDefinitions.$inferInsert> = { updatedAt: new Date(), updatedBy: tenant.userId };
      if (payload.name !== undefined && nameKey(payload.name) !== existing.nameKey) {
        await this.assertNameFree(tx, tenant, business.id, nameKey(payload.name));
        changes.name = payload.name.replace(/\s+/g, " ");
        changes.nameKey = nameKey(payload.name);
      }
      if (payload.unit !== undefined && existing.kind === "number") changes.unit = payload.unit?.trim() || null;
      if (payload.active !== undefined) changes.active = payload.active;
      if (payload.position !== undefined) changes.position = payload.position;
      await tx.update(attributeDefinitions).set(changes).where(and(eq(attributeDefinitions.tenantId, tenant.tenantId), eq(attributeDefinitions.id, existing.id)));
      if (payload.addOptions?.length) {
        if (!isList(existing.kind)) throw new ApiError("VALIDATION_ERROR", "Only a list attribute has choices.", 400, [{ field: "addOptions", message: "Not a list." }]);
        await this.addOptions(tx, tenant, business.id, existing.id, payload.addOptions);
      }
      await this.record(tx, tenant, business.id, "attribute.updated", existing.id, { before: { name: existing.name, active: existing.active }, after: { name: changes.name ?? existing.name, active: changes.active ?? existing.active }, addOptions: payload.addOptions ?? [] });
    });
    return this.one(tenant, id);
  }

  /** A variant's attributes, as stored. */
  async valuesOf(executor: DbExecutor, tenantId: string, productIds: string[]) {
    const out = new Map<string, { attributeId: string; name: string; kind: string; unit: string | null; value: string; optionIds: string[] }[]>();
    if (productIds.length === 0) return out;
    const rows = await executor
      .select({ value: variantAttributeValues, definition: attributeDefinitions, option: attributeOptions })
      .from(variantAttributeValues)
      .innerJoin(attributeDefinitions, and(eq(attributeDefinitions.tenantId, variantAttributeValues.tenantId), eq(attributeDefinitions.id, variantAttributeValues.attributeId)))
      .leftJoin(attributeOptions, and(eq(attributeOptions.tenantId, variantAttributeValues.tenantId), eq(attributeOptions.id, variantAttributeValues.optionId)))
      .where(and(eq(variantAttributeValues.tenantId, tenantId), inArray(variantAttributeValues.productId, productIds)))
      .orderBy(asc(attributeDefinitions.position), asc(attributeDefinitions.nameKey), asc(attributeOptions.position));
    for (const { value, definition, option } of rows) {
      const list = out.get(value.productId) ?? [];
      let entry = list.find((item) => item.attributeId === definition.id);
      const text =
        option?.value ??
        value.textValue ??
        (value.numberValue !== null ? `${trimNumber(value.numberValue)}${definition.unit ? ` ${definition.unit}` : ""}` : value.boolValue === null ? "" : value.boolValue ? "Yes" : "No");
      if (!entry) {
        entry = { attributeId: definition.id, name: definition.name, kind: definition.kind, unit: definition.unit, value: text, optionIds: [] };
        list.push(entry);
      } else entry.value = `${entry.value}, ${text}`;
      if (option) entry.optionIds.push(option.id);
      out.set(value.productId, list);
    }
    return out;
  }

  async productValues(tenant: TenantContext, productId: string) {
    const business = await requireBusiness(this.db, tenant);
    await this.requireProduct(this.db, tenant, business.id, productId);
    return { attributes: (await this.valuesOf(this.db, tenant.tenantId, [productId])).get(productId) ?? [] };
  }

  /** Sets a variant's attributes. Each attribute listed is replaced; one listed with no value is cleared. */
  async setProductValues(tenant: TenantContext, productId: string, raw: unknown) {
    const payload = parse(variantAttributesSchema, raw, "Check the attributes.");
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await this.requireProduct(tx, tenant, business.id, productId);
      const { definitions, options } = await this.load(tx, tenant, business.id, payload.values.map((value) => value.attributeId));
      for (const [index, value] of payload.values.entries()) {
        const definition = definitions.get(value.attributeId);
        if (!definition) throw new ApiError("ATTRIBUTE_NOT_FOUND", "That attribute was not found.", 404, [{ field: `values.${index}.attributeId`, message: "Not found." }]);
        await tx.delete(variantAttributeValues).where(and(eq(variantAttributeValues.tenantId, tenant.tenantId), eq(variantAttributeValues.productId, product.id), eq(variantAttributeValues.attributeId, definition.id)));
        for (const row of this.rowsFor(definition, options, value, index)) {
          await tx.insert(variantAttributeValues).values({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, productId: product.id, attributeId: definition.id, ...row, updatedBy: tenant.userId });
        }
      }
      await this.record(tx, tenant, business.id, "product.attributes_set", product.id, { values: payload.values.length }, "product");
    });
    return this.productValues(tenant, productId);
  }

  /**
   * One variant per combination of the chosen choices, under the item. A combination a variant already has (by its
   * attribute values, or by the same name) is skipped, so running it again adds only what is new.
   */
  async generateVariants(tenant: TenantContext, itemId: string, raw: unknown) {
    const payload = parse(generateVariantsSchema, raw, "Check the choices.");
    const business = await requireBusiness(this.db, tenant);
    const item = await requireItem(this.db, tenant, business.id, itemId);
    if (new Set(payload.attributes.map((entry) => entry.attributeId)).size !== payload.attributes.length) {
      throw new ApiError("VALIDATION_ERROR", "Choose each attribute once.", 400, [{ field: "attributes", message: "Repeated." }]);
    }
    const { definitions, options } = await this.load(this.db, tenant, business.id, payload.attributes.map((entry) => entry.attributeId));
    const lists = payload.attributes.map((entry, index) => {
      const definition = definitions.get(entry.attributeId);
      if (!definition || !definition.active) throw new ApiError("ATTRIBUTE_NOT_FOUND", "That attribute was not found.", 404, [{ field: `attributes.${index}.attributeId`, message: "Not found." }]);
      if (definition.kind !== "select") throw new ApiError("VALIDATION_ERROR", `Variants are made from a one-choice list. "${definition.name}" is not one.`, 400, [{ field: `attributes.${index}.attributeId`, message: "Not a one-choice list." }]);
      return [...new Set(entry.optionIds)].map((optionId) => {
        const option = options.get(optionId);
        if (!option || option.attributeId !== definition.id) throw new ApiError("OPTION_NOT_FOUND", `That choice is not one of "${definition.name}".`, 400, [{ field: `attributes.${index}.optionIds`, message: "Not a choice of this attribute." }]);
        return { definition, option };
      });
    });
    const wanted = combinations(lists);
    if (wanted.length > VARIANT_GENERATION_MAX) {
      throw new ApiError("TOO_MANY_VARIANTS", `That makes ${wanted.length} variants. Choose fewer, up to ${VARIANT_GENERATION_MAX} at a time.`, 400, [{ field: "attributes", message: "Too many combinations." }]);
    }
    // What the item already has: its variants' names and their choices.
    const existing = await this.db
      .select({ id: products.id, variantLabel: products.variantLabel, baseUnit: products.baseUnit })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.catalogItemId, item.id), isNull(products.archivedAt)));
    const values = await this.valuesOf(this.db, tenant.tenantId, existing.map((variant) => variant.id));
    const takenKeys = new Set<string>();
    for (const variant of existing) {
      if (variant.variantLabel) takenKeys.add(`label:${nameKey(variant.variantLabel)}`);
      const chosen = (values.get(variant.id) ?? []).filter((entry) => definitions.has(entry.attributeId)).flatMap((entry) => entry.optionIds);
      if (chosen.length === payload.attributes.length) takenKeys.add(`options:${[...chosen].sort().join(",")}`);
    }
    const plan = wanted.map((combo) => {
      const label = combo.map((part) => part.option.value).join(" / ");
      const optionIds = combo.map((part) => part.option.id);
      const skip = takenKeys.has(`label:${nameKey(label)}`) || takenKeys.has(`options:${[...optionIds].sort().join(",")}`);
      return { label, name: variantName(item.name, label), combo, skip };
    });
    const toMake = plan.filter((entry) => !entry.skip);
    const result = { item: { id: item.id, name: item.name }, wouldMake: toMake.map((entry) => entry.name), skipped: plan.filter((entry) => entry.skip).map((entry) => entry.name), made: [] as { id: string; name: string }[] };
    if (payload.dryRun || toMake.length === 0) return result;
    const baseUnit = payload.baseUnit ?? existing[0]?.baseUnit ?? "piece";
    await this.db.transaction(async (tx) => {
      for (const entry of toMake) {
        const productId = await this.products.createIn(tx, tenant, {
          name: entry.name,
          baseUnit,
          catalogItemId: item.id,
          variantLabel: entry.label,
          trackStock: item.itemType === "physical",
          ...(payload.priceMinor ? { priceMinor: payload.priceMinor } : {}),
        } as Parameters<ProductService["createIn"]>[2]);
        for (const part of entry.combo) {
          await tx.insert(variantAttributeValues).values({ id: newId(), tenantId: tenant.tenantId, businessId: business.id, productId, attributeId: part.definition.id, optionId: part.option.id, updatedBy: tenant.userId });
        }
        result.made.push({ id: productId, name: entry.name });
      }
      await this.record(tx, tenant, business.id, "catalog_item.variants_generated", item.id, { made: result.made.map((entry) => entry.name), skipped: result.skipped.length }, "catalog_item");
    });
    return result;
  }

  // Helpers ----------------------------------------------------------------------------------------------------

  private rowsFor(definition: Definition, options: Map<string, Option>, value: ReturnType<typeof variantAttributesSchema.parse>["values"][number], index: number) {
    const field = `values.${index}`;
    const wrong = (message: string) => new ApiError("VALIDATION_ERROR", message, 400, [{ field, message }]);
    const kind = definition.kind as AttributeKind;
    if (kind === "select" || kind === "multi_select") {
      const ids = [...new Set(value.optionIds ?? [])];
      if (kind === "select" && ids.length > 1) throw wrong(`Choose one ${definition.name}.`);
      for (const id of ids) {
        const option = options.get(id);
        if (!option || option.attributeId !== definition.id) throw wrong(`That choice is not one of "${definition.name}".`);
      }
      return ids.map((optionId) => ({ optionId }));
    }
    if (value.optionIds?.length) throw wrong(`"${definition.name}" is not a list.`);
    if (kind === "text") return value.text ? [{ textValue: value.text }] : [];
    if (kind === "number") return value.number ? [{ numberValue: value.number }] : [];
    return value.boolean === undefined ? [] : [{ boolValue: value.boolean }];
  }

  private async load(executor: DbExecutor, tenant: TenantContext, businessId: string, attributeIds: string[]) {
    const ids = [...new Set(attributeIds)];
    const definitions = new Map<string, Definition>();
    const options = new Map<string, Option>();
    if (ids.length === 0) return { definitions, options };
    for (const row of await executor
      .select()
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenant.tenantId), eq(attributeDefinitions.businessId, businessId), inArray(attributeDefinitions.id, ids)))) {
      definitions.set(row.id, row);
    }
    if (definitions.size) {
      for (const row of await executor
        .select()
        .from(attributeOptions)
        .where(and(eq(attributeOptions.tenantId, tenant.tenantId), eq(attributeOptions.businessId, businessId), inArray(attributeOptions.attributeId, [...definitions.keys()])))) {
        options.set(row.id, row);
      }
    }
    return { definitions, options };
  }

  private async addOptions(tx: DbExecutor, tenant: TenantContext, businessId: string, attributeId: string, values: string[]) {
    const existing = await tx.select({ valueKey: attributeOptions.valueKey, position: attributeOptions.position }).from(attributeOptions).where(and(eq(attributeOptions.tenantId, tenant.tenantId), eq(attributeOptions.attributeId, attributeId)));
    const taken = new Set(existing.map((option) => option.valueKey));
    let position = existing.reduce((max, option) => Math.max(max, option.position), -1) + 1;
    for (const raw of values) {
      const value = raw.replace(/\s+/g, " ").trim();
      const key = nameKey(value);
      if (!key || taken.has(key)) continue;
      taken.add(key);
      await tx.insert(attributeOptions).values({ id: newId(), tenantId: tenant.tenantId, businessId, attributeId, value, valueKey: key, position });
      position += 1;
    }
  }

  private async one(tenant: TenantContext, id: string) {
    const all = await this.list(tenant);
    const found = all.items.find((item) => item.id === id);
    if (!found) throw new ApiError("ATTRIBUTE_NOT_FOUND", "That attribute was not found.", 404);
    return found;
  }

  private async assertNameFree(tx: DbExecutor, tenant: TenantContext, businessId: string, key: string) {
    const [taken] = await tx
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenant.tenantId), eq(attributeDefinitions.businessId, businessId), eq(attributeDefinitions.nameKey, key)))
      .limit(1);
    if (taken) throw new ApiError("DUPLICATE_NAME", "There is already an attribute with this name.", 409, [{ field: "name", message: "Already used." }]);
  }

  private async requireDefinition(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [definition] = await executor
      .select()
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenant.tenantId), eq(attributeDefinitions.businessId, businessId), eq(attributeDefinitions.id, id)))
      .limit(1);
    if (!definition) throw new ApiError("ATTRIBUTE_NOT_FOUND", "That attribute was not found.", 404);
    return definition;
  }

  private async requireProduct(executor: DbExecutor, tenant: TenantContext, businessId: string, id: string) {
    const [product] = await executor
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenant.tenantId), eq(products.businessId, businessId), eq(products.id, id)))
      .limit(1);
    if (!product) throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.", 404);
    return product;
  }

  private present(definition: Definition, options: Option[]) {
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      unit: definition.unit,
      active: definition.active,
      position: definition.position,
      options: options.map((option) => ({ id: option.id, value: option.value, active: option.active })),
    };
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, action: string, entityId: string, metadata: Record<string, unknown>, entityType = "attribute") {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType, entityId, correlationId: tenant.correlationId, businessId, actorType: tenant.actorType ?? "HUMAN", metadata },
      tx,
    );
  }
}

const isList = (kind: string) => kind === "select" || kind === "multi_select";

function trimNumber(value: string) {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
