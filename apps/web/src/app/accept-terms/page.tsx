"use client";

import { TERMS_VERSION } from "@bizora/contracts";
import { Button, Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TermsCheckbox } from "../../components/terms-checkbox";
import { api } from "../../lib/api";
import { signOutEverywhere } from "../../lib/offline/sw-client";

/**
 * Owners who have not accepted the current Terms of use come here before anything else in the app (ADR-039):
 * after signing up with Google, or after the terms change.
 */
export default function AcceptTermsPage() {
  const t = useTranslations("terms");
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("/api/v1/auth/me")
      .then(async (response) => {
        if (response.status === 401) return window.location.assign("/login");
        const me = response.ok ? (await response.json()).data : null;
        if (me && !me.termsRequired) window.location.assign("/app");
      })
      .catch(() => undefined);
  }, []);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (!agreed) return setError(t("required"));
    setPending(true);
    setError(null);
    try {
      const response = await api("/api/v1/auth/accept-terms", { method: "POST", body: JSON.stringify({ version: TERMS_VERSION, accept: true }) });
      if (!response.ok) {
        setError(((await response.json().catch(() => null))?.error?.message as string | undefined) ?? t("failed"));
        return;
      }
      window.location.assign("/app");
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  const points = t.raw("points") as string[];
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-8">
      <Card className="w-full space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("lead")}</p>
        </div>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <a href="/terms" target="_blank" rel="noopener" className="inline-block text-sm font-medium text-primary underline underline-offset-2">
          {t("read")}
        </a>
        <form className="space-y-4" onSubmit={(event) => void accept(event)}>
          <TermsCheckbox checked={agreed} onChange={setAgreed} />
          {error ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? t("pending") : t("accept")}
            </Button>
            <button
              type="button"
              className="text-sm text-muted underline underline-offset-2"
              onClick={() => void signOutEverywhere().then(() => window.location.assign("/login"))}
            >
              {t("signOut")}
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}
