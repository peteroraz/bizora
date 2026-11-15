// Remembers (per browser) that this device is in Shop mode, so expired sessions go back to the
// staff PIN screen instead of the email sign-in page. The real check is the httpOnly device cookie.
const KEY = "bizora.shopMode";

export function setShopMode(on: boolean) {
  try {
    if (on) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable (private mode); Shop mode still works through the device cookie.
  }
}

export function isShopMode(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Only same-site paths inside the app are allowed as a post-login destination. */
export function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith("/app") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}
