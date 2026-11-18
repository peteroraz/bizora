"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { addDays, formatDay } from "../i18n/format";

/**
 * "‹ Today ›" plus a "Pick a day" button that opens the phone's or computer's calendar, to go straight to any day.
 * The day's name comes from the business's own date (`today`), never the phone's clock, and is written out
 * ("Tue 3 Nov"), so a calendar that shows US-style dates does not decide how the day reads.
 */
export function DaySwitcher({ day, today, onChange }: { day: string; today: string; onChange: (day: string) => void }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const calendar = useRef<HTMLInputElement>(null);
  // Older browsers cannot open the calendar from a button: show the date box itself instead.
  const [typing, setTyping] = useState(false);
  const label = day === today ? t("today") : day === addDays(today, -1) ? t("yesterday") : formatDay(day, locale);
  const pick = (value: string) => {
    if (DAY_PATTERN.test(value) && value <= today) onChange(value);
  };
  const openCalendar = () => {
    const input = calendar.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      setTyping(true);
    }
  };
  const box = "inline-flex h-11 items-center justify-center rounded-control border border-border";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="day-switcher">
      <div className="flex items-center gap-1">
        <button type="button" className={`${box} w-11`} aria-label={t("previousDay")} onClick={() => onChange(addDays(day, -1))}>
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <p className={`${box} min-w-36 px-3 text-sm font-medium`} aria-live="polite" data-testid="day-label">
          {label}
        </p>
        <button type="button" className={`${box} w-11 disabled:opacity-40`} aria-label={t("nextDay")} disabled={day >= today} onClick={() => onChange(addDays(day, 1))}>
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="relative flex items-center gap-2">
        <button type="button" className={`${box} gap-2 px-3 text-sm font-medium`} onClick={openCalendar} data-testid="pick-day">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {t("pickDay")}
        </button>
        <input
          ref={calendar}
          type="date"
          aria-label={t("pickDayLabel")}
          className={typing ? `${box} px-3 text-sm` : "pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"}
          tabIndex={typing ? 0 : -1}
          value={day}
          max={today}
          onChange={(event) => pick(event.target.value)}
          data-testid="day-input"
        />
        {day !== today ? (
          <button type="button" className={`${box} px-3 text-sm`} onClick={() => onChange(today)}>
            {t("backToToday")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A `?day=2026-11-03` from the address, if it is a real day no later than today. */
export function dayFromAddress(value: string | null, today: string) {
  return value && DAY_PATTERN.test(value) && value <= today && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}
