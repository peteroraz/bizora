/**
 * The short sign-in pass (access token, 15 minutes) is renewed with the long one (refresh token) before it runs
 * out, so someone working is never sent to the sign-in page (ADR-026). These helpers have no browser or server
 * dependencies, so the middleware, the browser client and the tests share them.
 */
export const SESSION_COOKIE = "bizora_session";
export const REFRESH_COOKIE = "bizora_refresh";
export const DEVICE_COOKIE = "bizora_device";
export const REFRESH_PATH = "/api/v1/auth/refresh";

/** Renew this long before the pass runs out, so a page that takes a moment to load does not cross the line. */
export const RENEW_EARLY_MS = 60_000;

/** True when the pass is missing, unreadable, or runs out within `RENEW_EARLY_MS`. The signature is the API's job. */
export function passNeedsRenewal(token: string | undefined, now = Date.now()) {
  if (!token) return true;
  const part = token.split(".")[1];
  if (!part) return true;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))) as { exp?: unknown };
    return typeof payload.exp !== "number" || payload.exp * 1000 - now < RENEW_EARLY_MS;
  } catch {
    return true;
  }
}

/** "name=value; Path=/; HttpOnly" → ["name", "value"]. */
export function cookiePair(setCookie: string): [string, string] | null {
  const pair = setCookie.split(";")[0] ?? "";
  const at = pair.indexOf("=");
  if (at <= 0) return null;
  return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
}

/** A 401 means "signed out" only when the server says so; a wrong password is also a 401 and must stay on the page. */
export function isSignedOutError(body: unknown) {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return code === undefined || code === "UNAUTHENTICATED";
}
