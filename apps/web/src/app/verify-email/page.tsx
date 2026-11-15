"use client";

import { Card, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslations } from "next-intl";

function VerifyEmail() {
  const t = useTranslations("verify");
  const token = useSearchParams().get("token") ?? "";
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    setMessage(t("done"));
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full space-y-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {message ? <p className="text-sm">{message}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? null : (
          <SafeForm pending={pending} onSubmit={confirm}>
            <SubmitButton pending={pending} pendingLabel={t("pending")} disabled={!token}>
              {t("submit")}
            </SubmitButton>
          </SafeForm>
        )}
        <p className="text-sm">
          <Link href="/app" className="font-medium text-primary">
            {t("continue")}
          </Link>
        </p>
      </Card>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
