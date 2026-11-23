import { savedItemKey, type SavedItem } from "@bizora/contracts";
import { api } from "../api";
import { CACHE_STORE, open, type OutboxOwner } from "./outbox";

/**
 * Items typed in at sales and remembered (ADR-041), saved on the phone so staff can pick them with no network.
 * Business-wide on the server; kept per person here like the other saved lists, and cleared on sign-out.
 */
export type SavedCatalog = {
  key: string;
  salesItems: string;
  items: SavedItem[];
  productAliases?: { productId: string; alias: string }[];
  units?: { code: string; displayName: string; standard?: boolean }[];
  syncedAt: string;
};
type Saved = SavedCatalog;

const keyOf = (owner: OutboxOwner) => `saved-items:${owner.tenantId}:${owner.membershipId}`;

async function store<T>(mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest | void): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await open();
  try {
    const transaction = db.transaction(CACHE_STORE, mode);
    const request = work(transaction.objectStore(CACHE_STORE));
    return await new Promise<T | null>((resolve, reject) => {
      transaction.oncomplete = () => resolve(((request as IDBRequest | undefined)?.result as T | undefined) ?? null);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const readSavedItems = (owner: OutboxOwner) => store<Saved>("readonly", (objects) => objects.get(keyOf(owner))).catch(() => null);

/** Gets the latest list; with no network, or if the server says no, the saved list stays. */
export async function refreshSavedItems(owner: OutboxOwner): Promise<Saved | null> {
  try {
    const response = await api("/api/v1/saved-items", {}, { background: true });
    if (!response.ok) return readSavedItems(owner);
    const { data } = (await response.json()) as { data: { salesItems: string; items: SavedItem[]; productAliases?: Saved["productAliases"]; units?: Saved["units"] } };
    const saved: Saved = { key: keyOf(owner), salesItems: data.salesItems, items: data.items, productAliases: data.productAliases ?? [], units: data.units ?? [], syncedAt: new Date().toISOString() };
    await store("readwrite", (objects) => void objects.put(saved));
    return saved;
  } catch {
    return readSavedItems(owner);
  }
}

/** After a sale, the phone remembers new typed items at once, so they can be picked next time even offline. */
export async function rememberOnPhone(owner: OutboxOwner, sold: { name: string; unit: string; priceMinor: string }[]) {
  const saved = (await readSavedItems(owner)) ?? { key: keyOf(owner), salesItems: "both", items: [], syncedAt: new Date(0).toISOString() };
  const now = new Date().toISOString();
  for (const item of sold) {
    const existing = saved.items.find((known) => savedItemKey(known.name) === savedItemKey(item.name));
    if (existing) Object.assign(existing, { unit: item.unit, lastPriceMinor: item.priceMinor, timesSold: existing.timesSold + 1, lastSoldAt: now });
    else saved.items.unshift({ id: `phone:${savedItemKey(item.name)}`, name: item.name, unit: item.unit, lastPriceMinor: item.priceMinor, timesSold: 1, lastSoldAt: now, aliases: [], catalogMode: "quick", productId: null, source: "typed" });
  }
  await store("readwrite", (objects) => void objects.put(saved)).catch(() => null);
  return saved;
}

export { asProduct } from "./typed-product";
