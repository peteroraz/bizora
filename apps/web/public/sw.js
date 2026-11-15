/*
 * Bizora service worker (ADR-015).
 * - Built files (/_next/static, icons) are cached the first time they load; their names change with every release.
 * - A few core screens are kept so the app opens with no network: network first, the saved copy only when offline.
 *   Any other screen opened with no network shows a short "no network" page.
 * - Saved screens are deleted when someone signs out or locks a shop device (message "purge-pages").
 * - API calls are never cached.
 */
const VERSION = "v2";
const STATIC_CACHE = `bizora-static-${VERSION}`;
const PAGES_CACHE = `bizora-pages-${VERSION}`;
const OFFLINE_PAGES = ["/app", "/app/sales/new", "/app/stock", "/app/customers/new", "/shop"];

const OFFLINE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bizora</title><body style="font-family:system-ui,sans-serif;padding:2rem;max-width:28rem;margin:auto"><h1 style="font-size:1.25rem">No network</h1><p>This screen has not been saved on this phone yet. Open it once while online, then it will work offline.</p><p><a href="/app/sales/new">Try the sales screen</a></p></body></html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("bizora-") && !key.endsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function offlinePage(url) {
  return OFFLINE_PAGES.includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  const navigation = request.mode === "navigate";
  if (navigation || (offlinePage(url) && request.headers.get("RSC") === "1")) {
    const keep = offlinePage(url);
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (keep && response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(PAGES_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          if (keep) {
            const cache = await caches.open(PAGES_CACHE);
            const cached = await cache.match(request, { ignoreSearch: !navigation });
            if (cached) return cached;
          }
          if (navigation) return new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
          return Response.error();
        }),
    );
  }
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "purge-pages") {
    // Everything but the shop PIN screen shows a signed-in person's details, so it goes.
    event.waitUntil(
      caches.open(PAGES_CACHE).then(async (cache) => {
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname !== "/shop") await cache.delete(request);
        }
      }),
    );
  }
  if (data.type === "warm") {
    event.waitUntil(
      (async () => {
        const staticCache = await caches.open(STATIC_CACHE);
        for (const url of data.urls || []) {
          if (!(await staticCache.match(url))) {
            try {
              const response = await fetch(url);
              if (response.ok) await staticCache.put(url, response);
            } catch {
              // Offline again; the next visit will try.
            }
          }
        }
        if (data.page && OFFLINE_PAGES.includes(data.page)) {
          const pages = await caches.open(PAGES_CACHE);
          try {
            const response = await fetch(data.page, { credentials: "include" });
            if (response.ok && !response.redirected) await pages.put(new Request(data.page), response);
          } catch {
            // Offline; keep any older copy.
          }
        }
      })(),
    );
  }
});
