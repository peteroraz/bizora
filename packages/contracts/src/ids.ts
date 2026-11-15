/**
 * Client-generated IDs (UUIDv7, RFC 9562): time-ordered, so records created offline sort by creation time
 * and index well. Works in browsers and Node 20+ through globalThis.crypto.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let millis = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(millis & 0xffn);
    millis >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Milliseconds since 1970 encoded in a UUIDv7. */
export function uuidv7Time(value: string): number {
  return Number.parseInt(value.replace(/-/g, "").slice(0, 12), 16);
}
