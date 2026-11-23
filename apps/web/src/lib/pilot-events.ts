import type { ClientPilotEvent } from "@bizora/contracts";

/**
 * Pilot measures from the phone (ADR-045): an event name from a fixed list and, at most, a short code. Never words
 * said, amounts, names or numbers. Best effort: kept in memory, sent in small batches, and dropped if the page closes
 * while offline. Measures must never slow down or stop a sale.
 */
const waiting: { name: ClientPilotEvent; detail?: string }[] = [];
let timer: number | null = null;

export function track(name: ClientPilotEvent, detail?: string) {
  if (typeof window === "undefined") return;
  waiting.push(detail && /^[A-Za-z0-9_.:-]{1,48}$/.test(detail) ? { name, detail } : { name });
  if (waiting.length > 100) waiting.splice(0, waiting.length - 100);
  if (timer === null) timer = window.setTimeout(() => void flush(), 3_000);
}

async function flush() {
  timer = null;
  if (waiting.length === 0 || !navigator.onLine) return;
  const events = waiting.splice(0, 25);
  try {
    const response = await fetch("/api/v1/telemetry/events", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    // Signed out or a bad batch: drop it rather than try for ever.
    if (response.status >= 500) waiting.unshift(...events);
  } catch {
    waiting.unshift(...events);
  }
  if (waiting.length > 0) timer = window.setTimeout(() => void flush(), 30_000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}
