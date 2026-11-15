import { SYNC_MAX_BATCH, type SyncOperationResult, type SyncOperationType, uuidv7 } from "@bizora/contracts";
import { purgeOfflinePages } from "./sw-client";

/**
 * The device outbox (ADR-012): work done offline waits here in IndexedDB until the server accepts it.
 *
 * - Every item has a UUIDv7 that is also its idempotency key, so sending it twice never applies it twice.
 * - Items belong to the person who made them. Only that person's items are sent while they are signed in,
 *   so a shared shop phone never sends one staff member's work under another's name.
 * - The server is the authority. Rejected items stay visible until someone dismisses them; they are never retried.
 * - Signing out of Shop mode deletes the store, but only once nothing is waiting.
 */
export type OutboxOwner = { tenantId: string; membershipId: string };

export type OutboxItem = {
  id: string;
  type: SyncOperationType;
  payload: unknown;
  occurredAt: string;
  tenantId: string;
  membershipId: string;
  status: "pending" | "rejected";
  attempts: number;
  nextAttemptAt: number;
  error: { code: string; message: string } | null;
};

export type PushFn = (operations: { id: string; type: SyncOperationType; occurredAt: string; payload: unknown }[]) => Promise<SyncOperationResult[]>;

const DB_NAME = "bizora-offline";
const STORE = "outbox";
const DB_VERSION = 2;
export const CACHE_STORE = "cache";
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 10 * 60_000;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

/** Called whenever the outbox changes, so the screen can show "3 waiting to sync". */
export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function available() {
  return typeof indexedDB !== "undefined";
}

export function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("owner", ["tenantId", "membershipId"]);
      }
      // v2: products and stock downloaded for looking up with no network (lib/offline/catalog.ts).
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function all(): Promise<OutboxItem[]> {
  if (!available()) return [];
  const db = await open();
  try {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    const items = await new Promise<OutboxItem[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as OutboxItem[]);
      request.onerror = () => reject(request.error);
    });
    // UUIDv7 sorts by creation time, so this is the order the work was done in.
    return items.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    db.close();
  }
}

async function write(change: (store: IDBObjectStore) => void) {
  const db = await open();
  try {
    const transaction = db.transaction(STORE, "readwrite");
    change(transaction.objectStore(STORE));
    await done(transaction);
  } finally {
    db.close();
  }
  notify();
}

/** Queues work done offline. Returns the operation ID. */
export async function enqueue(
  owner: OutboxOwner,
  type: SyncOperationType,
  payload: unknown,
  options: { id?: string; now?: number } = {},
): Promise<string> {
  if (!available()) throw new Error("This browser cannot save work offline.");
  const now = options.now ?? Date.now();
  const item: OutboxItem = {
    id: options.id ?? uuidv7(now),
    type,
    payload,
    occurredAt: new Date(now).toISOString(),
    tenantId: owner.tenantId,
    membershipId: owner.membershipId,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
  };
  await write((store) => store.put(item));
  return item.id;
}

const mine = (owner: OutboxOwner) => (item: OutboxItem) => item.tenantId === owner.tenantId && item.membershipId === owner.membershipId;

export async function summary(owner?: OutboxOwner) {
  const items = await all();
  const scoped = owner ? items.filter(mine(owner)) : items;
  return {
    pending: scoped.filter((item) => item.status === "pending").length,
    rejected: scoped.filter((item) => item.status === "rejected"),
    /** Everything waiting on this device, whoever made it. */
    devicePending: items.filter((item) => item.status === "pending").length,
  };
}

/** Removes rejected items once the person has seen them. */
export async function dismissRejected(owner: OutboxOwner) {
  const rejected = (await all()).filter((item) => mine(owner)(item) && item.status === "rejected");
  if (rejected.length > 0) await write((store) => rejected.forEach((item) => store.delete(item.id)));
}

export function backoffDelay(attempts: number, random = Math.random) {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (0.8 + random() * 0.4));
}

/**
 * Sends this person's waiting items, oldest first, in batches. Stops at the first network failure and backs off,
 * so later items never overtake earlier ones.
 */
export async function flush(owner: OutboxOwner, push: PushFn, now: number = Date.now(), options: { force?: boolean } = {}) {
  const due = (await all()).filter((item) => mine(owner)(item) && item.status === "pending");
  // While backing off, wait. Coming back online forces a try straight away.
  if (due.length === 0 || (!options.force && due.some((item) => item.nextAttemptAt > now))) {
    return { sent: 0, applied: 0, rejected: 0, failed: false };
  }
  let applied = 0;
  let rejected = 0;
  let sent = 0;
  for (let start = 0; start < due.length; start += SYNC_MAX_BATCH) {
    const batch = due.slice(start, start + SYNC_MAX_BATCH);
    let results: SyncOperationResult[];
    try {
      results = await push(batch.map(({ id, type, occurredAt, payload }) => ({ id, type, occurredAt, payload })));
    } catch {
      const remaining = due.slice(start);
      await write((store) =>
        remaining.forEach((item) => {
          const attempts = item.attempts + 1;
          store.put({ ...item, attempts, nextAttemptAt: now + backoffDelay(attempts) });
        }),
      );
      return { sent, applied, rejected, failed: true };
    }
    const byId = new Map(results.map((result) => [result.id, result]));
    await write((store) =>
      batch.forEach((item) => {
        const result = byId.get(item.id);
        if (!result) return;
        if (result.status === "rejected") store.put({ ...item, status: "rejected", error: result.error });
        else store.delete(item.id);
      }),
    );
    sent += batch.length;
    applied += results.filter((result) => result.status !== "rejected").length;
    rejected += results.filter((result) => result.status === "rejected").length;
  }
  return { sent, applied, rejected, failed: false };
}

/** Deletes everything stored on this device. Refuses while work is still waiting to sync. */
export async function clearDevice() {
  if (!available()) return;
  const waiting = (await summary()).devicePending;
  if (waiting > 0) throw new OutboxNotEmptyError(waiting);
  purgeOfflinePages();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
  notify();
}

export class OutboxNotEmptyError extends Error {
  constructor(public readonly waiting: number) {
    super(`${waiting} changes are still waiting to sync.`);
    this.name = "OutboxNotEmptyError";
  }
}
