"use client";

import { Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { OauthButtons } from "../../components/oauth-buttons";
import { PublicFooter } from "../../components/public-footer";

function LoginForm() {
  const t = useTranslations("login");
  const router = useRouter();
  const params = useSearchParams();
  const reason = params.get("reason");
  const reasonMessage =
    reason === "session"
      ? t("session")
      : reason === "link"
        ? t("link")
        : reason === "oauth"
          ? t("oauth")
          : reason === "invite"
            ? t("invite")
            : reason === "email"
              ? t("emailUnconfirmed")
              : null;
  const [error, setError] = useState<string | null>(reasonMessage);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    if (payload.data?.needsOrganizationSetup) {
      router.push("/setup");
      return;
    }
    if (payload.data?.needsWorkspaceSelection) {
      router.push("/select-workspace");
      return;
    }
    const me = await fetch("/api/v1/auth/me", { credentials: "include" }).then((result) => result.json());
    router.push(me.data?.onboardingCompleted === false ? "/app/onboarding" : "/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="mt-6">
          <OauthButtons returnTo="/app" />
        </div>
        <SafeForm className="mt-4 space-y-4" pending={pending} onSubmit={onSubmit}>
          <FormField id="email" label={t("email")}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </FormField>
          <FormField id="password" label={t("password")}>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </FormField>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <SubmitButton pending={pending} pendingLabel={t("pending")} className="w-full">
            {t("submit")}
          </SubmitButton>
        </SafeForm>
        <p className="mt-4 text-sm">
          <Link href="/forgot-password" className="font-medium text-primary">
            {t("forgot")}
          </Link>
        </p>
        <p className="mt-4 text-sm">
          {t("new")}{" "}
          <Link href="/register" className="font-medium text-primary">
            {t("create")}
          </Link>
        </p>
      </Card>
      <PublicFooter />
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
