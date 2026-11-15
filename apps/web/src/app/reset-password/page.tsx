"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Card, SafeForm, SubmitButton } from "@bizora/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { PasswordWithConfirmation } from "../../components/password-fields";
import { confirmPasswordError } from "../../lib/password";

function ResetForm() {
  const t = useTranslations("reset");
  const passwordText = useTranslations("password");
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function mismatchFor(nextPassword: string, nextConfirmation: string) {
    return confirmPasswordError(nextPassword, nextConfirmation) ? passwordText("mismatch") : null;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!event.currentTarget.reportValidity()) return;
    const mismatchError = mismatchFor(password, confirmation);
    const rulesMet = passwordRules.every((rule) => rule.met(password));
    if (mismatchError || !rulesMet) {
      setMismatch(mismatchError);
      setError(rulesMet ? null : t("rules"));
      return;
    }
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    router.push("/login");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <SafeForm className="mt-6 space-y-4" pending={pending} onSubmit={onSubmit}>
          <PasswordWithConfirmation
            passwordId="password"
            confirmId="confirmPassword"
            password={password}
            confirmation={confirmation}
            onPasswordChange={(value) => {
              setPassword(value);
              if (confirmation) setMismatch(mismatchFor(value, confirmation));
            }}
            onConfirmationChange={(value) => {
              setConfirmation(value);
              setMismatch(value ? mismatchFor(password, value) : null);
            }}
            mismatch={mismatch}
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <SubmitButton pending={pending} pendingLabel={t("pending")} disabled={!token} className="w-full">
            {t("submit")}
          </SubmitButton>
        </SafeForm>
      </Card>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
