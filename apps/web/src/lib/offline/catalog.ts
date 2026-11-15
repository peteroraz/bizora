import { CACHE_STORE, open } from "./outbox";

/**
 * Products and this shop's stock, downloaded so staff can look them up with no network (ADR-012, ADR-014).
 * One record per organization and shop. Cost fields are only present for people allowed to see them, because the
 * server leaves them out of the download. Turning off Shop mode deletes it with the rest of the device store.
 */
export type CachedProduct = {
  id: string;
  name: string;
  category: string | null;
  baseUnit: string;
  priceMinor: string | null;
  packs: { unitCode: string; baseQuantity: string; priceMinor: string | null }[];
  lowStockLevel: string | null;
  barcode: string | null;
  trackStock: boolean;
  archived: boolean;
};

export type Catalog = {
  key: string;
  currency: string;
  products: Record<string, CachedProduct>;
  quantities: Record<string, string>;
  cursors: { products: string | null; balances: string | null };
  syncedAt: string | null;
};

type PullPage = {
  branchId: string;
  currency: string;
  products: CachedProduct[];
  balances: { productId: string; quantity: string }[];
  cursors: { products: string | null; balances: string | null };
  done: boolean;
};

export type PullFn = (cursors: Catalog["cursors"]) => Promise<PullPage>;

const keyOf = (tenantId: string, branchId: string) => `catalog:${tenantId}:${branchId}`;

export async function readCatalog(tenantId: string, branchId: string): Promise<Catalog | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await open();
  try {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(keyOf(tenantId, branchId));
    return await new Promise<Catalog | null>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as Catalog | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeCatalog(catalog: Catalog) {
  const db = await open();
  try {
    const transaction = db.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put(catalog);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Downloads what changed since the last time, page by page, and saves it. */
export async function refreshCatalog(tenantId: string, branchId: string, pull: PullFn, now = new Date()): Promise<Catalog> {
  const catalog: Catalog = (await readCatalog(tenantId, branchId)) ?? {
    key: keyOf(tenantId, branchId),
    currency: "NGN",
    products: {},
    quantities: {},
    cursors: { products: null, balances: null },
    syncedAt: null,
  };
  for (let page = 0; page < 50; page += 1) {
    const result = await pull(catalog.cursors);
    catalog.currency = result.currency;
    for (const product of result.products) {
      if (product.archived) delete catalog.products[product.id];
      else catalog.products[product.id] = product;
    }
    for (const balance of result.balances) catalog.quantities[balance.productId] = balance.quantity;
    catalog.cursors = result.cursors;
    if (result.done) break;
  }
  catalog.syncedAt = now.toISOString();
  await writeCatalog(catalog);
  return catalog;
}

/** Search the saved products by name, category or barcode, sorted by name. */
export function searchCatalog(catalog: Catalog, query: string) {
  const needle = query.trim().toLowerCase();
  return Object.values(catalog.products)
    .filter(
      (product) =>
        !needle ||
        product.name.toLowerCase().includes(needle) ||
        (product.category ?? "").toLowerCase().includes(needle) ||
        product.barcode === query.trim(),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((product) => ({ ...product, quantity: catalog.quantities[product.id] ?? "0" }));
}
