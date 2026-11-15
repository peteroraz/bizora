/** Plain constants with no dependencies, safe to import anywhere in the browser without pulling in zod. */

export const PIN_LOCKOUT = {
  staffFailures: 5,
  staffLockMinutes: 15,
  deviceFailures: 20,
  deviceWindowHours: 24,
  autoLockMinutesDefault: 5,
} as const;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

export const CUSTOMER_PAGE_SIZE = 25;
export const PRODUCT_PAGE_SIZE = 25;
/** How many products or balances one offline download page carries. */
export const PULL_PAGE_SIZE = 500;

/** Header every offline-capable write carries. A retry with the same key returns the first result. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
/** Response header set when the server returns a stored result instead of running the request again. */
export const IDEMPOTENT_REPLAY_HEADER = "idempotent-replayed";
/** How many operations one sync push may carry. */
export const SYNC_MAX_BATCH = 50;
