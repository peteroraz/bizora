"use client";

import { WEEKDAYS, type OpeningHours, type Weekday } from "@bizora/contracts";
import { Badge, Button, Card, FormField, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatWhen } from "../i18n/format";
import { api } from "../lib/api";
import { SentenceInput } from "./typing";

type Settings = {
  hours: OpeningHours | null;
  timezone: string;
  shops: { id: string; name: string; lockedAt: string | null; lockNote: string | null }[];
  permits: { id: string; membershipId: string; name: string; role: string; until: string; note: string | null }[];
};
type Person = { membershipId: string; displayName: string | null; email: string | null; role: string; status?: string };
type Day = { open: boolean; from: string; to: string };

const PERMIT_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
const draftFrom = (hours: OpeningHours | null): Record<Weekday, Day> =>
  Object.fromEntries(WEEKDAYS.map((day) => [day, hours?.[day] ? { open: true, from: hours[day]!.open, to: hours[day]!.close } : { open: !hours && day !== "sun", from: "08:00", to: "19:00" }])) as Record<Weekday, Day>;

/**
 * The owner's controls (ADR-034): opening hours, locking a shop at once, and letting one person work outside the
 * hours until a set time. Outside the hours, or in a locked shop, only the owner can change the books.
 */
export function WorkRulesSettings() {
  const t = useTranslations("workRules");
  const common = useTranslations("common");
  const locale = useLocale();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [useHours, setUseHours] = useState(false);
  const [days, setDays] = useState<Record<Weekday, Day>>(draftFrom(null));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [who, setWho] = useState("");
  const [howLong, setHowLong] = useState("2");
  const [permitNote, setPermitNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  function show(next: Settings) {
    setSettings(next);
    setUseHours(Boolean(next.hours));
    setDays(draftFrom(next.hours));
  }

  useEffect(() => {
    void (async () => {
      const [rules, team] = await Promise.all([api("/api/v1/work-rules").catch(() => null), api("/api/v1/memberships").catch(() => null)]);
      if (rules?.ok) show((await rules.json()).data);
      if (team?.ok) setPeople(((await team.json()).data.items as Person[]).filter((person) => person.role !== "OWNER" && (person.status ?? "ACTIVE") === "ACTIVE"));
    })();
  }, []);

  async function send(kind: string, path: string, init: RequestInit, done: string) {
    setPending(kind);
    setMessage(null);
    const response = await api(path, init).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(null);
    if (!response?.ok) {
      setMessage({ tone: "danger", text: payload?.error?.fieldErrors?.[0]?.message ?? payload?.error?.message ?? t("failed") });
      return false;
    }
    show(payload.data);
    setMessage({ tone: "success", text: done });
    return true;
  }

  if (!settings) return <p className="text-sm text-muted">{common("loading")}</p>;
  const when = (iso: string) => formatWhen(iso, locale, settings.timezone);

  return (
    <div className="space-y-4">
      {message ? (
        <p className={`text-sm ${message.tone === "danger" ? "text-danger" : "text-success"}`} role={message.tone === "danger" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      <Card className="space-y-4" data-testid="opening-hours">
        <div>
          <p className="text-sm font-medium">{t("hoursTitle")}</p>
          <p className="text-sm text-muted">{t("hoursLead", { zone: settings.timezone })}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useHours} onChange={(event) => setUseHours(event.target.checked)} />
          {t("useHours")}
        </label>
        {useHours ? (
          <div className="space-y-2">
            {WEEKDAYS.map((day) => {
              const value = days[day];
              const change = (next: Partial<Day>) => setDays((current) => ({ ...current, [day]: { ...current[day], ...next } }));
              return (
                <div key={day} className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-1 text-sm sm:grid-cols-[9rem_8rem_auto_8rem]">
                  <label className="col-span-3 flex items-center gap-2 sm:col-span-1">
                    <input type="checkbox" checked={value.open} onChange={(event) => change({ open: event.target.checked })} aria-label={t("openOn", { day: t(`days.${day}`) })} />
                    {t(`days.${day}`)}
                  </label>
                  {value.open ? (
                    <>
                      <input type="time" className="min-h-11 w-full rounded-control border border-border bg-background px-2" value={value.from} onChange={(event) => change({ from: event.target.value })} aria-label={t("opensAt", { day: t(`days.${day}`) })} />
                      <span className="text-muted">{t("to")}</span>
                      <input type="time" className="min-h-11 w-full rounded-control border border-border bg-background px-2" value={value.to} onChange={(event) => change({ to: event.target.value })} aria-label={t("closesAt", { day: t(`days.${day}`) })} />
                    </>
                  ) : (
                    <span className="col-span-3 text-muted sm:col-span-1">{t("closedDay")}</span>
                  )}
                </div>
              );
            })}
            <Button type="button" variant="secondary" onClick={() => setDays((current) => Object.fromEntries(WEEKDAYS.map((day) => [day, day === "sun" ? current.sun : { ...current.mon }])) as Record<Weekday, Day>)}>
              {t("copyMonday")}
            </Button>
            <p className="text-xs text-muted">{t("overnight")}</p>
          </div>
        ) : (
          <p className="text-sm text-muted">{t("anyTime")}</p>
        )}
        <Button
          type="button"
          disabled={pending === "hours"}
          onClick={() => {
            const hours = useHours ? (Object.fromEntries(WEEKDAYS.map((day) => [day, days[day].open ? { open: days[day].from, close: days[day].to } : null])) as OpeningHours) : null;
            void send("hours", "/api/v1/work-rules/hours", { method: "PUT", body: JSON.stringify({ hours }) }, useHours ? t("hoursSaved") : t("hoursOff"));
          }}
        >
          {pending === "hours" ? common("saving") : t("saveHours")}
        </Button>
      </Card>

      <Card className="space-y-3" data-testid="shop-locks">
        <div>
          <p className="text-sm font-medium">{t("locksTitle")}</p>
          <p className="text-sm text-muted">{t("locksLead")}</p>
        </div>
        <ul className="divide-y divide-border">
          {settings.shops.map((shop) => (
            <li key={shop.id} className="flex flex-wrap items-end justify-between gap-3 py-3">
              <div className="text-sm">
                <p className="font-medium">
                  {shop.name} {shop.lockedAt ? <Badge tone="danger">{t("lockedBadge")}</Badge> : null}
                </p>
                {shop.lockedAt ? <p className="text-muted">{t("lockedSince", { when: when(shop.lockedAt) })}{shop.lockNote ? ` · ${shop.lockNote}` : ""}</p> : null}
              </div>
              {shop.lockedAt ? (
                <Button type="button" variant="secondary" disabled={pending === shop.id} onClick={() => void send(shop.id, `/api/v1/branches/${shop.id}/unlock`, { method: "POST" }, t("unlocked", { shop: shop.name }))}>
                  {t("unlock", { shop: shop.name })}
                </Button>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <FormField id={`lock-note-${shop.id}`} label={t("lockNote")} hint={common("optional")}>
                    <SentenceInput id={`lock-note-${shop.id}`} value={notes[shop.id] ?? ""} maxLength={240} onChange={(event) => setNotes((current) => ({ ...current, [shop.id]: event.target.value }))} />
                  </FormField>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={pending === shop.id}
                    onClick={() => void send(shop.id, `/api/v1/branches/${shop.id}/lock`, { method: "POST", body: JSON.stringify(notes[shop.id]?.trim() ? { note: notes[shop.id]!.trim() } : {}) }, t("locked", { shop: shop.name }))}
                  >
                    {t("lock", { shop: shop.name })}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3" data-testid="work-permits">
        <div>
          <p className="text-sm font-medium">{t("permitsTitle")}</p>
          <p className="text-sm text-muted">{t("permitsLead")}</p>
        </div>
        {settings.permits.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {settings.permits.map((permit) => (
              <li key={permit.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>
                  {t("permitLine", { name: permit.name, until: when(permit.until) })}
                  {permit.note ? <span className="text-muted"> · {permit.note}</span> : null}
                </span>
                <Button type="button" variant="secondary" disabled={pending === permit.id} onClick={() => void send(permit.id, `/api/v1/work-permits/${permit.id}/stop`, { method: "POST" }, t("permitStopped", { name: permit.name }))}>
                  {t("stopPermit")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("noPermits")}</p>
        )}
        {people.length > 0 ? (
          <SafeForm
            className="grid gap-3 sm:grid-cols-3"
            pending={pending === "permit"}
            onSubmit={async () => {
              if (!who) return setMessage({ tone: "danger", text: t("choosePerson") });
              const person = people.find((item) => item.membershipId === who);
              const until = new Date(Date.now() + Number(howLong) * 3_600_000).toISOString();
              const ok = await send("permit", "/api/v1/work-permits", { method: "POST", body: JSON.stringify({ membershipId: who, until, ...(permitNote.trim() ? { note: permitNote.trim() } : {}) }) }, t("permitted", { name: person?.displayName ?? person?.email ?? "" }));
              if (ok) {
                setWho("");
                setPermitNote("");
              }
            }}
          >
            <FormField id="permit-person" label={t("person")}>
              <Select id="permit-person" value={who} onChange={(event) => setWho(event.target.value)}>
                <option value="">{t("choosePerson")}</option>
                {people.map((person) => (
                  <option key={person.membershipId} value={person.membershipId}>
                    {person.displayName ?? person.email}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="permit-hours" label={t("howLong")}>
              <Select id="permit-hours" value={howLong} onChange={(event) => setHowLong(event.target.value)}>
                {PERMIT_HOURS.map((hours) => (
                  <option key={hours} value={hours}>
                    {t("forHours", { count: hours })}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="permit-note" label={t("why")} hint={common("optional")}>
              <SentenceInput id="permit-note" value={permitNote} maxLength={240} onChange={(event) => setPermitNote(event.target.value)} />
            </FormField>
            <div className="sm:col-span-3">
              <SubmitButton pending={pending === "permit"} pendingLabel={common("saving")}>
                {t("letWork")}
              </SubmitButton>
            </div>
          </SafeForm>
        ) : null}
      </Card>
    </div>
  );
}
