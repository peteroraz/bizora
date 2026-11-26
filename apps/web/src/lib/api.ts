import { takeEarly } from "./early-requests";
import { isSignedOutError, REFRESH_PATH } from "./session-pass";
import { isShopMode } from "./shop-mode";

type Renewal = "renewed" | "signed-out" | "offline";

let pending: Promise<Renewal> | null = null;

async function postRefresh(): Promise<Renewal> {
  try {
    const response = await fetch(REFRESH_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.ok ? "renewed" : "signed-out";
  } catch {
    return "offline";
  }
}

/**
 * Renews the sign-in pass once for every request that found it expired. Tabs take turns through a browser lock,
 * so a second tab renews with the token the first one just received instead of the one it replaced.
 */
export function renewSession(): Promise<Renewal> {
  pending ??= (async () => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks ? ((await locks.request("bizora-session-renewal", postRefresh)) as Renewal) : postRefresh();
  })().finally(() => {
    pending = null;
  });
  return pending;
}

async function signedOut(response: Response) {
  if (response.status !== 401) return false;
  return isSignedOutError(await response.clone().json().catch(() => null));
}

let leaving = false;
function goToSignIn() {
  if (leaving) return;
  leaving = true;
  if (isShopMode()) {
    window.location.href = "/shop";
    return;
  }
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/login?reason=session&returnTo=${encodeURIComponent(here)}`;
}

function send(path: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers, credentials: "include" });
}

/**
 * Calls the API. An expired pass is renewed and the request sent again, so nobody is signed out while working.
 * Only when renewal fails (signed out elsewhere, a week without use, device removed) does the page go to sign-in;
 * `background` calls such as sync never move the page, the next thing the person does will.
 */
export async function api(path: string, init: RequestInit = {}, options: { background?: boolean } = {}) {
  // A plain GET the page's HTML already started (ADR-072). If it failed, ask as usual.
  const early = !init.method && !init.body && !init.headers ? takeEarly(path) : null;
  const response = (early ? await early.catch(() => null) : null) ?? (await send(path, init));
  if (typeof window === "undefined" || path.startsWith(REFRESH_PATH) || !(await signedOut(response))) return response;
  const outcome = await renewSession();
  if (outcome === "renewed") {
    const retried = await send(path, init);
    if (!(await signedOut(retried))) return retried;
  }
  if (outcome !== "offline" && !options.background) goToSignIn();
  return response;
}
