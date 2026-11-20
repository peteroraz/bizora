import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { PAYMENT_METHODS } from "./sales.js";
import { parseQuantity, UNIT_CODES } from "./stock-units.js";

/**
 * Jobs (ADR-035): work done for a customer, as a mechanic, tailor, electrician, plumber or any service business
 * records it. A job (job card, repair order) holds the work, the parts from stock, the parts bought for it and what
 * helpers were paid. Money taken before the job is finished is a deposit; finishing the job bills the customer,
 * takes the deposits off, and leaves the rest owed.
 */
export const JOB_STATUSES = ["open", "done", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * - work: the service itself (workmanship, labour, sewing, wiring), charged to the customer;
 * - part: something from the shop's own stock, charged to the customer;
 * - bought: something bought outside for this job; it is added to the products so it can be picked next time;
 * - helper: money paid to someone who helped (a vulcaniser, an electrician called in); a cost, not charged.
 */
export const JOB_LINE_KINDS = ["work", "part", "bought", "helper"] as const;
export type JobLineKind = (typeof JOB_LINE_KINDS)[number];

/** How a bought part or a helper was paid. Owed means the supplier or helper is still to be paid. */
export const JOB_PAID_FROM = ["cash", "bank", "owed"] as const;
export type JobPaidFrom = (typeof JOB_PAID_FROM)[number];

/** A job can be recorded up to this many days after the day it happened. */
export const JOB_MAX_DAYS_BACK = 31;

const minorAmount = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const positiveAmount = minorAmount.refine((value) => BigInt(value) > 0n, "Enter an amount above zero.");
const quantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const text = (max: number) => z.string().trim().min(1).max(max);

export const jobLineInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("work"),
    description: text(160),
    /** A saved regular job (a product that keeps no stock); its price fills in but can change. */
    productId: z.string().uuid().optional(),
    quantity: quantity.default("1"),
    /** Price for one; the line is quantity × price. */
    unitPriceMinor: minorAmount,
    /** Save this as a regular job so it can be picked or said next time. */
    save: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("part"),
    productId: z.string().uuid(),
    quantity,
    unit: z.enum(UNIT_CODES),
    /** Left out: the product's price. */
    unitPriceMinor: minorAmount.optional(),
  }),
  z.object({
    kind: z.literal("bought"),
    description: text(160),
    /** Bought before: the product it was saved as. */
    productId: z.string().uuid().optional(),
    quantity,
    unit: z.enum(UNIT_CODES).default("piece"),
    /** What was paid for all of them. */
    costMinor: positiveAmount,
    /** Charged to the customer for all of them. Left out: what it cost. */
    chargeMinor: minorAmount.optional(),
    paidFrom: z.enum(JOB_PAID_FROM).default("cash"),
    /** Where it was bought; needed when it is still owed. */
    supplier: z.string().trim().max(160).optional(),
  }),
  z.object({
    kind: z.literal("helper"),
    /** Who helped and what they did. */
    description: text(160),
    costMinor: positiveAmount,
    paidFrom: z.enum(JOB_PAID_FROM).default("cash"),
  }),
]);
export type JobLineInput = z.infer<typeof jobLineInputSchema>;

export const jobPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: positiveAmount,
  reference: z.string().trim().max(80).optional(),
});

export const jobCreateSchema = z
  .object({
    id: z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.").optional(),
    customerId: z.string().uuid().optional(),
    /** A new customer: a name is enough; the rest can be added later on their page. */
    customer: z.object({ name: text(160), phone: z.string().trim().max(32).optional() }).optional(),
    /** What is being worked on: "Toyota Corolla LND 123 AB", "Wedding agbada", "Kitchen sink". */
    title: z.string().trim().max(160).optional(),
    /** The problem, or what the customer asked for. */
    problem: z.string().trim().max(1000).optional(),
    /** The AI's summary of what was said, kept with the job. */
    summary: z.string().trim().max(600).optional(),
    /** The day the job came in (its records go on that day). Today if left out; up to 31 days back. */
    day: isoDate.optional(),
    /** When the customer was told it would be ready. */
    promisedOn: isoDate.optional(),
    lines: z.array(jobLineInputSchema).max(100).default([]),
    /** Money taken now: a deposit, or full payment when the job is finished at once. */
    payment: jobPaymentSchema.optional(),
    /** Finish and bill the job now (a job done while the customer waited). */
    finish: z.boolean().optional(),
    /** When a balance left on a finished job should be paid. */
    dueDate: isoDate.optional(),
  })
  .refine((value) => Boolean(value.customerId) !== Boolean(value.customer), { message: "Choose the customer, or give a new customer's name.", path: ["customer"] });
export type JobCreateInput = z.infer<typeof jobCreateSchema>;

export const jobUpdateSchema = z.object({
  title: z.string().trim().max(160).optional(),
  problem: z.string().trim().max(1000).optional(),
  promisedOn: isoDate.nullable().optional(),
});

export const jobAddLinesSchema = z.object({
  lines: z.array(jobLineInputSchema).min(1).max(100),
  /** The day these were used or bought. Today if left out. */
  day: isoDate.optional(),
});
export const jobRemoveLineSchema = z.object({ reason: z.string().trim().min(3, "Say why, in a few words.").max(240) });
export const jobFinishSchema = z.object({ dueDate: isoDate.optional(), day: isoDate.optional() });
export const jobCancelSchema = z.object({ reason: z.string().trim().min(3, "Say why, in a few words.").max(240) });
export const jobPayDaySchema = jobPaymentSchema.extend({ day: isoDate.optional() });

export const JOB_PAGE_SIZE = 50;
