/**
 * The content security policy for every page (ADR-036). Scripts run only when they carry this request's nonce (and
 * what those scripts load); nothing loads from other sites; pages cannot be framed. Violations are reported to the
 * API, which logs them.
 */
export function contentSecurityPolicy(nonce: string, options: { https: boolean; development: boolean }) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    // React and Tailwind set some styles inline; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // Voice notes play back from the phone's memory.
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
    "report-uri /api/v1/telemetry/csp",
  ].join("; ");
}

/** A random, single-use value for this request's scripts. */
export function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
