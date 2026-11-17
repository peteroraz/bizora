"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { addDays, formatDay } from "../i18n/format";

/**
 * "‹ Today ›" instead of a date box: the phone's date picker often shows US dates (11/17/2026).
 * The day's name comes from the business's own date (`today`), never the phone's clock.
 */
export function DaySwitcher({ day, today, onChange }: { day: string; today: string; onChange: (day: string) => void }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const label = day === today ? t("today") : day === addDays(today, -1) ? t("yesterday") : formatDay(day, locale);
  return (
    <div className="flex items-center gap-1" data-testid="day-switcher">
      <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-border" aria-label={t("previousDay")} onClick={() => onChange(addDays(day, -1))}>
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <label className="relative inline-flex h-11 min-w-36 cursor-pointer items-center justify-center rounded-control border border-border px-3 text-sm font-medium">
        <span>{label}</span>
        {/* The real date box sits under the label, so tapping the label still opens the phone's calendar. */}
        <input type="date" className="absolute inset-0 cursor-pointer opacity-0" aria-label={t("pickDay")} value={day} max={today} onChange={(event) => event.target.value && onChange(event.target.value)} />
      </label>
      <button
        type="button"
        className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-border disabled:opacity-40"
        aria-label={t("nextDay")}
        disabled={day >= today}
        onClick={() => onChange(addDays(day, 1))}
      >
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Quick choices for when credit should be paid, plus the calendar for any other day. */
export function DueDatePicker({ id, value, today, onChange }: { id: string; value: string; today: string; onChange: (day: string) => void }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const choices = [
    [7, t("inWeek")],
    [14, t("inTwoWeeks")],
    [30, t("inMonth")],
  ] as const;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {choices.map(([days, text]) => {
          const day = addDays(today, days);
          return (
            <button
              key={days}
              type="button"
              className={`min-h-11 rounded-pill border px-3 text-sm ${value === day ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
              onClick={() => onChange(day)}
            >
              {text}
            </button>
          );
        })}
        <label className="relative inline-flex min-h-11 cursor-pointer items-center rounded-pill border border-border px-3 text-sm">
          {t("otherDay")}
          <input id={id} type="date" className="absolute inset-0 cursor-pointer opacity-0" min={today} value={value} onChange={(event) => onChange(event.target.value)} />
        </label>
      </div>
      {value ? <p className="text-sm">{t("dueOn", { date: formatDay(value, locale) })}</p> : null}
    </div>
  );
}
