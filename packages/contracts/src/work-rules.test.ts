import { describe, expect, it } from "vitest";
import { isOpenAt, openingHoursSchema, type OpeningHours } from "./work-rules.js";

const week = (hours: { open: string; close: string } | null): OpeningHours => ({ mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: hours, sun: null });
// Wednesday 19 Nov 2026 in Lagos (UTC+1).
const at = (time: string, date = "2026-11-19") => new Date(`${date}T${time}:00+01:00`);

describe("opening hours", () => {
  it("is always open with no hours set", () => {
    expect(isOpenAt(null, at("03:00"), "Africa/Lagos")).toBe(true);
  });

  it("is open from the opening time up to, not including, the closing time, in the business's time zone", () => {
    const hours = week({ open: "08:00", close: "19:00" });
    expect(isOpenAt(hours, at("07:59"), "Africa/Lagos")).toBe(false);
    expect(isOpenAt(hours, at("08:00"), "Africa/Lagos")).toBe(true);
    expect(isOpenAt(hours, at("18:59"), "Africa/Lagos")).toBe(true);
    expect(isOpenAt(hours, at("19:00"), "Africa/Lagos")).toBe(false);
    // 08:30 in Lagos is 07:30 in London: the business's own clock counts.
    expect(isOpenAt(hours, at("08:30"), "Europe/London")).toBe(false);
  });

  it("is closed on a closed day, and handles hours that run past midnight", () => {
    const night = week({ open: "18:00", close: "02:00" });
    expect(isOpenAt(night, at("23:00"), "Africa/Lagos")).toBe(true);
    expect(isOpenAt(night, at("01:30", "2026-11-20"), "Africa/Lagos")).toBe(true);
    expect(isOpenAt(night, at("02:30", "2026-11-20"), "Africa/Lagos")).toBe(false);
    // Sunday is closed, but Saturday night's hours still run into early Sunday.
    expect(isOpenAt(night, at("01:00", "2026-11-22"), "Africa/Lagos")).toBe(true);
    expect(isOpenAt(night, at("20:00", "2026-11-22"), "Africa/Lagos")).toBe(false);
  });

  it("refuses times that are not times", () => {
    expect(openingHoursSchema.safeParse({ ...week({ open: "8am", close: "19:00" }) }).success).toBe(false);
    expect(openingHoursSchema.safeParse({ ...week({ open: "08:00", close: "08:00" }) }).success).toBe(false);
  });
});
