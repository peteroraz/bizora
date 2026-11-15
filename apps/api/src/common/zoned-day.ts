function partsOf(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;
  let hour = Number(lookup.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const wall = partsOf(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - date.getTime();
}

export function zonedDateTime(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}Z`);
  if (Number.isNaN(guess.getTime())) {
    throw new Error("Invalid zoned date.");
  }
  const offset = timeZoneOffsetMs(guess, timeZone);
  const corrected = new Date(guess.getTime() - offset);
  const again = timeZoneOffsetMs(corrected, timeZone);
  return offset === again ? corrected : new Date(guess.getTime() - again);
}

export function zonedDayBounds(timeZone: string, now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const start = zonedDateTime(date, "00:00:00", timeZone);
  return { date, start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The calendar date (YYYY-MM-DD) at that moment in the business's timezone. */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
