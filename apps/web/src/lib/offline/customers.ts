import { CACHE_STORE, open } from "./outbox";
import { api } from "../api";
import type { OutboxOwner } from "./outbox";

/**
 * Customer names saved on the phone for matching a spoken sale with no network (ADR-040). Names, IDs and whether
 * they may buy on credit only: never phones or emails. Kept per business and per person, because what a person may
 * see depends on their role. Cleared on sign-out.
 */
export type DirectoryCustomer = { id: string; name: string; creditAllowed: boolean };
type Directory = { key: string; items: DirectoryCustomer[]; truncated: boolean; scope: "all" | "credit_and_recent"; syncedAt: string };

const keyOf = (owner: OutboxOwner) => `customers:${owner.tenantId}:${owner.membershipId}`;

async function read(key: string): Promise<Directory | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await open();
  try {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(key);
    return await new Promise<Directory | null>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as Directory | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function write(directory: Directory) {
  const db = await open();
  try {
    const transaction = db.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put(directory);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readCustomerDirectory(owner: OutboxOwner) {
  return read(keyOf(owner));
}

/** Downloads the names again when there is a network; keeps the saved list when there is not. */
export async function refreshCustomerDirectory(owner: OutboxOwner): Promise<Directory | null> {
  const saved = await read(keyOf(owner)).catch(() => null);
  try {
    const response = await api("/api/v1/customers/directory", {}, { background: true });
    if (!response.ok) return saved;
    const data = (await response.json()).data as Omit<Directory, "key" | "syncedAt">;
    const directory: Directory = { key: keyOf(owner), items: data.items, truncated: data.truncated, scope: data.scope, syncedAt: new Date().toISOString() };
    await write(directory);
    return directory;
  } catch {
    return saved;
  }
}

/**
 * Removes the products, stock and customer names saved on this phone, for every business. Work waiting to sync is
 * kept, so nothing is lost. Called on sign-out.
 */
export async function clearSavedLists() {
  if (typeof indexedDB === "undefined") return;
  const db = await open();
  try {
    const transaction = db.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
