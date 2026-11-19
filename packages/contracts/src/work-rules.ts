import { z } from "zod";

/**
 * Shop locks, opening hours and permission to work outside them (ADR-034). Outside the hours, or in a locked shop,
 * only the owner changes the books; the owner can let a staff member work outside the hours until a set time.
 */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:00.");
export const dayHoursSchema = z.object({ open: clock, close: clock }).refine((value) => value.open !== value.close, { message: "Opening and closing times must differ.", path: ["close"] });
export type DayHours = z.infer<typeof dayHoursSchema>;

/** Each day's hours, or null when the business is closed that day. A close earlier than the open runs past midnight. */
export const openingHoursSchema = z.object(Object.fromEntries(WEEKDAYS.map((day) => [day, dayHoursSchema.nullable()])) as Record<Weekday, z.ZodNullable<typeof dayHoursSchema>>);
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/** Null turns the hours off: staff can work at any time. */
export const setOpeningHoursSchema = z.object({ hours: openingHoursSchema.nullable() });

export const shopLockSchema = z.object({ note: z.string().trim().max(240).optional() });

export const WORK_PERMIT_MAX_HOURS = 24 * 14;
export const workPermitSchema = z.object({
  membershipId: z.string().uuid(),
  /** When the permission ends. It starts now. */
  until: z.string().datetime({ offset: true }),
  note: z.string().trim().max(240).optional(),
});

export const stockRequestDecisionSchema = z.object({ note: z.string().trim().max(240).optional() });
export const stockRequestRejectSchema = z.object({ note: z.string().trim().min(3, "Say why, in a few words.").max(240) });

export const STOCK_REQUEST_KINDS = ["receive", "adjust", "transfer", "supplier_return"] as const;
export type StockRequestKind = (typeof STOCK_REQUEST_KINDS)[number];

function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = get("weekday").toLowerCase().slice(0, 3) as Weekday;
  return { day, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether the business is open at a moment, in its own time zone. No hours set means always open. */
export function isOpenAt(hours: OpeningHours | null | undefined, date: Date, timeZone: string): boolean {
  if (!hours) return true;
  const { day, minutes } = wallClock(date, timeZone);
  const index = WEEKDAYS.indexOf(day);
  const today = hours[day];
  const yesterday = hours[WEEKDAYS[(index + 6) % 7] as Weekday];
  if (today) {
    const open = minutesOf(today.open);
    const close = minutesOf(today.close);
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  // Yesterday's hours that ran past midnight.
  if (yesterday && minutesOf(yesterday.close) < minutesOf(yesterday.open) && minutes < minutesOf(yesterday.close)) return true;
  return false;
}

/** Today's hours in the business's time zone, for "Open 08:00–19:00 today". */
export function hoursToday(hours: OpeningHours | null | undefined, date: Date, timeZone: string): DayHours | null {
  if (!hours) return null;
  return hours[wallClock(date, timeZone).day] ?? null;
}
