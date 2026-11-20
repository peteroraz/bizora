"use client";

import { buttonVariants } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

const KNOWN = ["not_allowed", "removed", "unverified", "different_account", "expired", "google"] as const;
type Known = (typeof KNOWN)[number];

export function SignIn() {
  const t = useTranslations("signIn");
  const [error, setError] = useState<Known | null>(null);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("error");
    setError(KNOWN.find((known) => known === value) ?? null);
  }, []);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-4 py-24">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </div>
      {error ? (
        <p role="alert" className="rounded-card border border-danger bg-danger-bg px-4 py-3 text-sm text-danger">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {/* A full page visit: Google's sign-in cannot open inside this page. */}
      <a href="/api/admin/v1/auth/google/start" className={buttonVariants({ size: "lg" })}>
        {t("google")}
      </a>
    </main>
  );
}
