"use client";

import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@bizora/contracts";
import { Avatar, Badge, Button, Card, EmptyState, useHydrated } from "@bizora/ui";
import { Delete } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { setShopMode } from "../../lib/shop-mode";

type StaffOption = { id: string; displayName: string; role: string; lockedUntil: string | null };
type ShopInfo = { branchName: string | null; businessName: string | null; staff: StaffOption[] };
type Status = "loading" | "ready" | "off" | "suspended";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export default function ShopModePage() {
  const t = useTranslations("shop");
  const roles = useTranslations("roles");
  const format = useFormatter();
  const hydrated = useHydrated();
  const [status, setStatus] = useState<Status>("loading");
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [selected, setSelected] = useState<StaffOption | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/v1/shop/device", { credentials: "include", cache: "no-store" });
    if (response.status === 423) {
      setShopMode(true);
      setStatus("suspended");
      return;
    }
    if (!response.ok) {
      setShopMode(false);
      setStatus("off");
      return;
    }
    setShopMode(true);
    setInfo((await response.json()).data as ShopInfo);
    setStatus("ready");
  }

  useEffect(() => {
    void load();
  }, []);

  function press(digit: string) {
    setError(null);
    setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + digit));
  }

  async function submit() {
    if (!selected || pending || pin.length < PIN_MIN_LENGTH) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/shop/pin-login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId: selected.id, pin }),
      });
      if (response.ok) {
        window.location.assign("/app");
        return;
      }
      const payload = await response.json().catch(() => null);
      setPin("");
      if (payload?.error?.code === "DEVICE_SUSPENDED") {
        setStatus("suspended");
        return;
      }
      setError(payload?.error?.code === "INVALID_PIN" ? t("wrongPin") : (payload?.error?.message ?? t("wrongPin")));
      if (payload?.error?.code === "STAFF_LOCKED") void load();
    } finally {
      setPending(false);
    }
  }

  function roleLabel(role: string) {
    return roles.has(role) ? roles(role) : role;
  }

  const ownerLink = (
    <Link href="/login?returnTo=%2Fapp%2Fstaff" className="text-sm font-medium text-primary">
      {t("ownerSignIn")}
    </Link>
  );

  if (status === "loading") {
    return <main className="min-h-screen bg-bg" aria-busy="true" />;
  }

  if (status === "off" || status === "suspended") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4">
        <EmptyState
          title={status === "off" ? t("offTitle") : t("suspendedTitle")}
          description={status === "off" ? t("offBody") : t("suspendedBody")}
        />
        {ownerLink}
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-4 py-8">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{selected ? t("hello", { name: selected.displayName }) : t("title")}</h1>
        <p className="mt-1 text-sm text-muted">
          {t("subtitle", { branch: info?.branchName ?? "", business: info?.businessName ?? "" })}
        </p>
      </header>

      {!selected ? (
        <section aria-label={t("pickName")} className="space-y-3">
          <p className="text-center text-sm font-medium">{t("pickName")}</p>
          {info?.staff.length === 0 ? <p className="text-center text-sm text-muted">{t("noStaff")}</p> : null}
          <ul className="grid grid-cols-2 gap-3">
            {info?.staff.map((member) => (
              <li key={member.id}>
                <button
                  type="button"
                  disabled={!hydrated}
                  onClick={() => {
                    setSelected(member);
                    setPin("");
                    setError(null);
                  }}
                  className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-card border border-border bg-card p-4 text-center shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Avatar name={member.displayName} />
                  <span className="font-medium">{member.displayName}</span>
                  <span className="text-xs text-muted">{roleLabel(member.role)}</span>
                  {member.lockedUntil ? (
                    <Badge tone="warning">
                      {t("lockedUntil", { time: format.dateTime(new Date(member.lockedUntil), { timeStyle: "short" }) })}
                    </Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Card className="space-y-5">
          <p className="text-center text-sm font-medium">{t("enterPin")}</p>
          <div className="flex justify-center gap-3" aria-live="polite" aria-label={t("pinEntered", { count: pin.length })}>
            {Array.from({ length: PIN_MAX_LENGTH }, (_, index) => (
              <span
                key={index}
                className={`h-4 w-4 rounded-pill border border-border ${index < pin.length ? "bg-primary" : "bg-transparent"}`}
              />
            ))}
          </div>
          {error ? (
            <p className="text-center text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="grid grid-cols-3 gap-3" role="group" aria-label={t("pinPad")}>
            {DIGITS.map((digit) => (
              <Button
                key={digit}
                type="button"
                variant="secondary"
                className="h-16 text-2xl"
                aria-label={t("digit", { digit })}
                disabled={!hydrated || pending}
                onClick={() => press(digit)}
              >
                {digit}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="h-16"
              disabled={!hydrated || pending}
              onClick={() => {
                setPin("");
                setError(null);
              }}
            >
              {t("clear")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-16 text-2xl"
              aria-label={t("digit", { digit: "0" })}
              disabled={!hydrated || pending}
              onClick={() => press("0")}
            >
              {0}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-16"
              aria-label={t("delete")}
              disabled={!hydrated || pending}
              onClick={() => setPin((current) => current.slice(0, -1))}
            >
              <Delete className="h-6 w-6" aria-hidden="true" />
            </Button>
          </div>
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={!hydrated || pending || pin.length < PIN_MIN_LENGTH}
            onClick={() => void submit()}
          >
            {pending ? t("signingIn") : t("submit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setSelected(null);
              setPin("");
              setError(null);
            }}
          >
            {t("back")}
          </Button>
        </Card>
      )}
      <div className="text-center">{ownerLink}</div>
    </main>
  );
}
