/**
 * Talks to the service worker (public/sw.js), which keeps a copy of a few core screens so the app opens with no
 * network (ADR-015). Pages are personal, so the copy is deleted whenever someone signs out, locks a shop device or
 * turns off Shop mode.
 */
function post(message: unknown) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage(message);
}

export function purgeOfflinePages() {
  post({ type: "purge-pages" });
}

/** Signs out and forgets the saved screens. */
export async function signOutEverywhere() {
  purgeOfflinePages();
  await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
}

/** Saves the files this screen loaded, and the screen itself, so it can open next time with no network. */
export function warmOfflineCopy() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) => {
    const urls = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${location.origin}/_next/static/`));
    registration.active?.postMessage({ type: "warm", urls, page: location.pathname });
  });
}
