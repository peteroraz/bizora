import type { SyncOperationResult } from "@bizora/contracts";
import { api } from "../api";
import { flush, type OutboxOwner, type PushFn } from "./outbox";

/** Sends operations to the server. Throws on network failure or a server error, so the outbox backs off. */
export const pushToServer: PushFn = async (operations) => {
  const response = await api("/api/v1/sync/push", { method: "POST", body: JSON.stringify({ operations }) }, { background: true });
  if (!response.ok) throw new Error(`Sync failed with ${response.status}`);
  const payload = (await response.json()) as { data: { results: SyncOperationResult[] } };
  return payload.data.results;
};

/** True when a fetch failed because the device is offline, not because the server refused. */
export function isNetworkFailure(error: unknown) {
  return error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
}

/**
 * Keeps trying to send this person's waiting work: when the browser comes back online, when the app comes back
 * to the foreground, and every 30 seconds. Returns a function that stops it.
 */
export function startBackgroundSync(owner: OutboxOwner, push: PushFn = pushToServer) {
  let running = false;
  const run = async (force = false) => {
    if (running || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    running = true;
    try {
      await flush(owner, push, Date.now(), { force });
    } catch {
      // Storage errors are shown through the outbox summary; try again on the next tick.
    } finally {
      running = false;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void run();
  };
  const onOnline = () => void run(true);
  const tick = () => void run();
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(tick, 30_000);
  void run(true);
  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
