"use client";

import { useLocale, useTranslations } from "next-intl";
import { addDays, formatDay } from "../i18n/format";

// Kept apart from the day switcher: the quick sale screen needs this one only (JavaScript budget, Spec §8).
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
