/**
 * A screen's first requests, started by a few lines in the page's HTML while its scripts are still downloading
 * (ADR-072). On a slow phone the scripts take about two seconds to arrive and start; by then the answers are here, so
 * the list or figures show as soon as the screen is ready instead of one round trip later.
 *
 * Only plain GETs that the screen always makes when opened with no query of its own. Anything else, or an answer
 * older than a few seconds, or one already used, is fetched as usual. Sign-in rides on the cookie, as for any request.
 */
export const EARLY_REQUESTS: Readonly<Record<string, readonly string[]>> = {
  "/app": ["/api/v1/auth/me", "/api/v1/dashboard", "/api/v1/notifications"],
  "/app/customers": ["/api/v1/customers?page=1", "/api/v1/notifications"],
  "/app/stock": ["/api/v1/products?page=1", "/api/v1/stock/expiring", "/api/v1/notifications"],
};

/** An early answer older than this is not used: the screen asks again. */
export const EARLY_MAX_AGE_MS = 10_000;

type EarlyStore = Record<string, { at: number; response: Promise<Response> }>;

/**
 * The script placed in the page. Plain ES5, no imports: it runs before anything else has loaded. A rejected request
 * (no network) is marked handled here, so it never shows as an error; the screen then fetches as usual.
 */
export function earlyRequestScript(): string {
  const map = JSON.stringify(EARLY_REQUESTS).replace(/</g, "\\u003c");
  return `(function(){try{var m=${map}[location.pathname];if(!m||location.search||!window.fetch)return;var s={},t=Date.now();for(var i=0;i<m.length;i++){var p=fetch(m[i],{credentials:"include"});p["catch"](function(){});s[m[i]]={at:t,response:p};}window.__bizoraEarly=s;}catch(e){}})();`;
}

/** The early answer for this request, once; null when there is none or it is too old. */
export function takeEarly(path: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const store = (window as unknown as { __bizoraEarly?: EarlyStore }).__bizoraEarly;
  const found = store?.[path];
  if (!store || !found) return null;
  delete store[path];
  return now - found.at <= EARLY_MAX_AGE_MS ? found.response : null;
}
