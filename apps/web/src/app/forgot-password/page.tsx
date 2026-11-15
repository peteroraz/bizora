"use client";

import { Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { PublicFooter } from "../../components/public-footer";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgot");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: new FormData(event.currentTarget).get("email") }),
    });
    setPending(false);
    if (!response.ok) {
      const payload = await response.json();
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {sent ? (
          <p className="mt-4 text-sm">{t("sent")}</p>
        ) : (
          <SafeForm className="mt-6 space-y-4" pending={pending} onSubmit={onSubmit}>
            <FormField id="email" label={t("email")}>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </FormField>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <SubmitButton pending={pending} pendingLabel={t("pending")} className="w-full">
              {t("submit")}
            </SubmitButton>
          </SafeForm>
        )}
        <p className="mt-4 text-sm">
          <Link href="/login" className="font-medium text-primary">
            {t("back")}
          </Link>
        </p>
      </Card>
      <PublicFooter />
    </main>
  );
}
