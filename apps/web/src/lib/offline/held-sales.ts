import type { Line } from "../../components/quick-sale-lines";
import { CACHE_STORE, open, type OutboxOwner } from "./outbox";

/**
 * Held sales (ADR-070): carts the cashier put aside ("Let me get cash from the ATM") to serve the next customer.
 * They live only on this phone, per person and shop, and never reach the server: no number, no money, no stock,
 * no books, no debt. They sit in the offline store, so signing out of Shop mode removes them with everything else.
 */
export type HeldSale = {
  id: string;
  name: string;
  heldAt: string;
  lines: Line[];
  customer: { id: string; name: string } | null;
  discount: string;
  mode: string;
  split: { cash: string; transfer: string; pos: string };
  note: string;
  dueDate: string;
  comment: string;
  chosenList: string;
  totalMinor: string;
  currency: string;
};

type Stored = { key: string; items: HeldSale[] };

/** After this long a held sale is shown as left from earlier, so it is resumed or deleted rather than forgotten. */
export const HELD_OLD_MS = 24 * 60 * 60 * 1000;
/** More than this and the oldest is not dropped: holding is refused, so nothing disappears unseen. */
export const HELD_LIMIT = 20;

const keyOf = (owner: OutboxOwner, branchId: string) => `held-sales:${owner.tenantId}:${owner.membershipId}:${branchId}`;

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

/** This person's held sales in this shop, oldest first. */
export async function readHeld(owner: OutboxOwner, branchId: string): Promise<HeldSale[]> {
  const saved = await store<Stored>("readonly", (objects) => objects.get(keyOf(owner, branchId))).catch(() => null);
  return [...(saved?.items ?? [])].sort((a, b) => a.heldAt.localeCompare(b.heldAt));
}

async function write(owner: OutboxOwner, branchId: string, items: HeldSale[]) {
  await store("readwrite", (objects) => void objects.put({ key: keyOf(owner, branchId), items } satisfies Stored));
  return readHeld(owner, branchId);
}

export class HeldFullError extends Error {
  constructor() {
    super("Too many held sales.");
    this.name = "HeldFullError";
  }
}

/** Holds a sale, or holds it again under the same id after it was resumed and changed. */
export async function putHeld(owner: OutboxOwner, branchId: string, sale: HeldSale) {
  const items = (await readHeld(owner, branchId)).filter((item) => item.id !== sale.id);
  if (items.length >= HELD_LIMIT) throw new HeldFullError();
  return write(owner, branchId, [...items, sale]);
}

/** Removes a held sale: recorded after resuming, or deleted. */
export async function dropHeld(owner: OutboxOwner, branchId: string, id: string) {
  return write(
    owner,
    branchId,
    (await readHeld(owner, branchId)).filter((item) => item.id !== id),
  );
}
