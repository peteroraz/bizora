import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { PRODUCT_PHOTO_MAX, PRODUCT_PHOTO_MAX_BYTES, PRODUCT_PHOTO_MAX_SIDE, PRODUCT_PHOTO_MIN_SIDE, productPhotoUploadSchema } from "@bizora/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { TenantContext } from "../../common/tenant-context.js";
import type { AppDatabase, DbExecutor } from "../../db/database.js";
import { productPhotos, products } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { imageSize } from "../branding/logo-image.js";
import { requireBusiness, requireProduct } from "./inventory-scope.js";

const PROBLEM = {
  not_image: "That is not a JPEG or PNG photo.",
  too_big: "That photo is too large. Try again; the app shrinks photos before sending.",
  too_small: "That photo is too small to see.",
  too_large_pixels: "That photo is too large. Try again; the app shrinks photos before sending.",
} as const;

export type ProductPhotoView = { id: string; position: number; width: number; height: number; url: string };

/** What the product list and screens show for a product's photos: their addresses, main photo first. */
export const photoUrl = (productId: string, photo: { id: string; sha256: string }) => `/api/v1/products/${productId}/photos/${photo.id}?v=${photo.sha256.slice(0, 12)}`;

/** The main photo of each product, for lists. */
export async function mainPhotos(executor: DbExecutor, tenantId: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, string>();
  const rows = await executor
    .select({ id: productPhotos.id, productId: productPhotos.productId, sha256: productPhotos.sha256 })
    .from(productPhotos)
    .where(and(eq(productPhotos.tenantId, tenantId), inArray(productPhotos.productId, productIds), eq(productPhotos.position, 0)));
  return new Map(rows.map((row) => [row.productId, photoUrl(row.productId, row)]));
}

/**
 * Product photos (ADR-033): up to 5 a product, so staff and customers can see what an item looks like. Photos are
 * checked from their own bytes (a real JPEG or PNG within the size limits), kept with the product, and served only
 * to signed-in staff of the business.
 */
@Injectable()
export class ProductPhotoService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, productId: string) {
    const business = await requireBusiness(this.db, tenant);
    await requireProduct(this.db, tenant, business.id, productId, { includeArchived: true });
    return { items: await this.views(tenant.tenantId, productId) };
  }

  async add(tenant: TenantContext, productId: string, raw: unknown) {
    const payload = productPhotoUploadSchema.parse(raw);
    const data = Buffer.from(payload.dataBase64, "base64");
    if (data.length > PRODUCT_PHOTO_MAX_BYTES) throw this.problem("too_big");
    const size = imageSize(data);
    if (!size || size.type !== payload.contentType) throw this.problem("not_image");
    if (size.width < PRODUCT_PHOTO_MIN_SIDE || size.height < PRODUCT_PHOTO_MIN_SIDE) throw this.problem("too_small");
    if (size.width > PRODUCT_PHOTO_MAX_SIDE || size.height > PRODUCT_PHOTO_MAX_SIDE) throw this.problem("too_large_pixels");
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await requireProduct(tx, tenant, business.id, productId);
      // One photo added at a time per product, so two phones cannot both add the fifth.
      await tx.select({ id: products.id }).from(products).where(and(eq(products.tenantId, tenant.tenantId), eq(products.id, product.id))).for("update");
      const existing = await tx
        .select({ position: productPhotos.position })
        .from(productPhotos)
        .where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.productId, product.id)));
      if (existing.length >= PRODUCT_PHOTO_MAX) {
        throw new ApiError("TOO_MANY_PHOTOS", `A product can have up to ${PRODUCT_PHOTO_MAX} photos. Remove one first.`, 409);
      }
      const sha256 = createHash("sha256").update(data).digest("hex");
      const id = newId();
      await tx.insert(productPhotos).values({
        id,
        tenantId: tenant.tenantId,
        businessId: business.id,
        productId: product.id,
        position: existing.length,
        contentType: size.type,
        data,
        byteSize: data.length,
        width: size.width,
        height: size.height,
        sha256,
        createdBy: tenant.userId,
      });
      await this.record(tx, tenant, business.id, "product.photo_added", product.id, { photoId: id, width: size.width, height: size.height, byteSize: data.length });
    });
    return this.list(tenant, productId);
  }

  async remove(tenant: TenantContext, productId: string, photoId: string) {
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await requireProduct(tx, tenant, business.id, productId, { includeArchived: true });
      const removed = await tx
        .delete(productPhotos)
        .where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.productId, product.id), eq(productPhotos.id, photoId)))
        .returning({ position: productPhotos.position });
      const gone = removed[0];
      if (!gone) throw new ApiError("NOT_FOUND", "Photo not found.", 404);
      // Close the gap so positions stay 0, 1, 2…
      await tx
        .update(productPhotos)
        .set({ position: sql`${productPhotos.position} - 1` })
        .where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.productId, product.id), sql`${productPhotos.position} > ${gone.position}`));
      await this.record(tx, tenant, business.id, "product.photo_removed", product.id, { photoId });
    });
    return this.list(tenant, productId);
  }

  /** Makes a photo the main one: it moves to the front, the others keep their order. */
  async makeMain(tenant: TenantContext, productId: string, photoId: string) {
    await this.db.transaction(async (tx) => {
      const business = await requireBusiness(tx, tenant);
      const product = await requireProduct(tx, tenant, business.id, productId);
      const rows = await tx
        .select({ id: productPhotos.id })
        .from(productPhotos)
        .where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.productId, product.id)))
        .orderBy(asc(productPhotos.position))
        .for("update");
      if (!rows.some((row) => row.id === photoId)) throw new ApiError("NOT_FOUND", "Photo not found.", 404);
      const order = [photoId, ...rows.map((row) => row.id).filter((id) => id !== photoId)];
      for (const [position, id] of order.entries()) {
        await tx.update(productPhotos).set({ position }).where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.id, id)));
      }
      await this.record(tx, tenant, business.id, "product.photo_main", product.id, { photoId });
    });
    return this.list(tenant, productId);
  }

  async file(tenant: TenantContext, productId: string, photoId: string) {
    const business = await requireBusiness(this.db, tenant);
    const [row] = await this.db
      .select({ contentType: productPhotos.contentType, data: productPhotos.data, sha256: productPhotos.sha256 })
      .from(productPhotos)
      .where(and(eq(productPhotos.tenantId, tenant.tenantId), eq(productPhotos.businessId, business.id), eq(productPhotos.productId, productId), eq(productPhotos.id, photoId)))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Photo not found.", 404);
    return { contentType: row.contentType, data: row.data, etag: `"${row.sha256.slice(0, 16)}"` };
  }

  private async views(tenantId: string, productId: string): Promise<ProductPhotoView[]> {
    const rows = await this.db
      .select({ id: productPhotos.id, position: productPhotos.position, width: productPhotos.width, height: productPhotos.height, sha256: productPhotos.sha256 })
      .from(productPhotos)
      .where(and(eq(productPhotos.tenantId, tenantId), eq(productPhotos.productId, productId)))
      .orderBy(asc(productPhotos.position));
    return rows.map((row) => ({ id: row.id, position: row.position, width: row.width, height: row.height, url: photoUrl(productId, row) }));
  }

  private problem(kind: keyof typeof PROBLEM) {
    return new ApiError("BAD_PHOTO", PROBLEM[kind], 400, [{ field: "photo", message: PROBLEM[kind] }]);
  }

  private async record(tx: DbExecutor, tenant: TenantContext, businessId: string, action: string, productId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId, action, entityType: "product", entityId: productId, correlationId: tenant.correlationId, businessId, actorType: tenant.actorType ?? "HUMAN", metadata },
      tx,
    );
  }
}
