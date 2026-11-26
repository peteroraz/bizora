/** "Hide for now" on the email check banner lasts a week (ADR-072). A cookie, so the page is drawn without it. */
export const VERIFY_BANNER_COOKIE = "bizora_verify_banner_hidden";
export const VERIFY_BANNER_HIDE_SECONDS = 7 * 24 * 60 * 60;

/** Remembers on this browser that the banner is hidden, for the given number of seconds. */
export function rememberVerifyBannerHidden(seconds: number) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${VERIFY_BANNER_COOKIE}=1; Max-Age=${seconds}; Path=/; SameSite=Lax${secure}`;
}
