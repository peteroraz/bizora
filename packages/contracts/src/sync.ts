import { z } from "zod";
import { isUuidV7 } from "./ids.js";

import { SYNC_MAX_BATCH } from "./constants.js";

export { IDEMPOTENCY_HEADER, IDEMPOTENT_REPLAY_HEADER, SYNC_MAX_BATCH } from "./constants.js";

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - or _ only.");

export const uuidV7Schema = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");

/** Operation types the server accepts from a device outbox. Sprints 4 and 5 add stock and sales operations. */
export const SYNC_OPERATION_TYPES = ["customer.create", "stock.receive", "stock.count", "sale.create", "payment.record"] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

export const syncOperationSchema = z.object({
  /** UUIDv7 made on the device. Also the idempotency key for this operation. */
  id: uuidV7Schema,
  type: z.enum(SYNC_OPERATION_TYPES),
  /** When the person did it on the device (ISO 8601). Kept for the record; the server time decides ordering. */
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.unknown(),
});
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncPushSchema = z.object({
  operations: z.array(syncOperationSchema).min(1).max(SYNC_MAX_BATCH),
});

export type SyncOperationResult =
  | { id: string; status: "applied" | "duplicate"; result: unknown }
  | { id: string; status: "rejected"; error: { code: string; message: string } };

/** Official numbers per business and document type, issued by the server in order. */
export const DOCUMENT_PREFIXES = {
  receipt: "R",
  invoice: "INV",
  payment: "PAY",
  stock_in: "SI",
  stock_count: "SC",
  stock_transfer: "TR",
  expense: "EXP",
} as const;
export type DocumentType = keyof typeof DOCUMENT_PREFIXES;

export function formatOfficialNumber(type: DocumentType, value: bigint | number): string {
  return `${DOCUMENT_PREFIXES[type]}-${value.toString().padStart(6, "0")}`;
}

/** A number a shop device gives a document while offline, e.g. DEV3-000045. The device number is unique per organization. */
export function provisionalNumber(deviceCode: number, sequence: number): string {
  return `DEV${deviceCode}-${sequence.toString().padStart(6, "0")}`;
}
