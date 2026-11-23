import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { UNIT_CODES, parseCountQuantity, parseQuantity } from "./stock-units.js";

/**
 * Transfers with a lifecycle and count sessions (ADR-047). Quantities travel as decimal strings and are stored as
 * thousandths of the product's base unit (ADR-014).
 */
export const BRANCH_KINDS = ["shop", "warehouse"] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

export const TRANSFER_STATUSES = ["requested", "approved", "dispatched", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const COUNT_SESSION_STATUSES = ["draft", "counting", "submitted", "approved", "posted", "cancelled"] as const;
export type CountSessionStatus = (typeof COUNT_SESSION_STATUSES)[number];
/** Why a counted quantity differs from what was expected. */
export const COUNT_REASONS = ["damaged", "missing", "count_correction", "expired", "other"] as const;

const clientId = z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.");
const quantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const countQuantity = z.string().trim().refine((value) => parseCountQuantity(value) !== null, "Enter how many you counted.");
const note = z.string().trim().max(240).optional();
const requiredNote = z.string().trim().min(3, "Say why, in a few words.").max(240);

export const transferLineSchema = z.object({
  productId: z.string().uuid(),
  quantity,
  unit: z.enum(UNIT_CODES),
});

export const transferCreateSchema = z.object({
  id: clientId.optional(),
  /** Where the stock leaves from. Staff kept to one shop always send from their own. */
  fromBranchId: z.string().uuid().optional(),
  toBranchId: z.string().uuid(),
  lines: z.array(transferLineSchema).min(1).max(100),
  note,
  /**
   * Send it now: the stock leaves at once and waits in transit for the receiver. Without this, the transfer is a
   * request for the sender to dispatch, after approval where the business needs one.
   */
  dispatchNow: z.boolean().optional(),
});

export const transferReceiveSchema = z.object({
  /** What arrived, line by line. Leave out to receive everything that was sent. Less than sent is recorded as missing. */
  lines: z.array(z.object({ lineId: z.string().uuid(), receivedQuantity: countQuantity })).max(100).optional(),
  note,
});

export const transferDecisionSchema = z.object({ note }).strict();
export const transferCancelSchema = z.object({ reason: requiredNote }).strict();

export const countSessionCreateSchema = z.object({
  id: clientId.optional(),
  branchId: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Give the count a name, such as Month-end count.").max(80),
  note,
});

export const countSessionLineSchema = z.object({
  productId: z.string().uuid(),
  countedQuantity: countQuantity,
  unit: z.enum(UNIT_CODES),
  reason: z.enum(COUNT_REASONS).optional(),
  note,
});

export const countSessionDecisionSchema = z.object({ note }).strict();
export const countSessionRejectSchema = z.object({ note: requiredNote }).strict();
