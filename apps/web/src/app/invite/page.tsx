"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Card, FormField, SafeForm, SubmitButton } from "@bizora/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { OauthButtons } from "../../components/oauth-buttons";
import { PasswordWithConfirmation } from "../../components/password-fields";
import { confirmPasswordError } from "../../lib/password";
import { NameInput } from "../../components/typing";

function InviteForm() {
  const t = useTranslations("invite");
  const passwordText = useTranslations("password");
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  function mismatchFor(nextPassword: string, nextConfirmation: string) {
    return confirmPasswordError(nextPassword, nextConfirmation) ? passwordText("mismatch") : null;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
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
    setMismatch(null);
    const response = await fetch("/api/v1/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: form.get("token"),
        displayName: form.get("displayName"),
        password,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setPending(false);
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    const login = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: payload.data.user.email, password }),
    });
    setPending(false);
    if (!login.ok) {
      router.push("/login");
      return;
    }
    const body = await login.json();
    if (body.data?.needsWorkspaceSelection) {
      router.push("/select-workspace");
      return;
    }
    router.push("/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="mt-6">
          <OauthButtons returnTo={`/invite?token=${encodeURIComponent(token)}`} intent="invite" token={token} />
        </div>
        <SafeForm className="mt-4 space-y-4" pending={pending} onSubmit={onSubmit}>
          <input type="hidden" name="token" value={token} />
          <FormField id="displayName" label={t("name")}>
            <NameInput id="displayName" name="displayName" autoComplete="name" required />
          </FormField>
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

export default function InvitePage() {
  return (
    <Suspense>
      <InviteForm />
    </Suspense>
  );
}
