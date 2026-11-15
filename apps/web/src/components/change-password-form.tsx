"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Card, SafeForm, SubmitButton } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { confirmPasswordError } from "../lib/password";
import { CurrentPasswordField, PasswordWithConfirmation } from "./password-fields";

export function ChangePasswordForm({ hasPassword = true }: { hasPassword?: boolean }) {
  const t = useTranslations("password");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function mismatchFor(nextPassword: string, nextConfirmation: string) {
    return confirmPasswordError(nextPassword, nextConfirmation) ? t("mismatch") : null;
  }

  async function onSubmit() {
    const mismatchError = mismatchFor(password, confirmation);
    const rulesMet = passwordRules.every((rule) => rule.met(password));
    if (mismatchError || !rulesMet) {
      setMismatch(mismatchError);
      setNotice(null);
      setError(rulesMet ? null : t("rules"));
      return;
    }
    setPending(true);
    setError(null);
    setMismatch(null);
    const response = await fetch("/api/v1/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(hasPassword ? { currentPassword, newPassword: password } : { newPassword: password }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("failed"));
      return;
    }
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setNotice(t("updated"));
  }

  return (
    <Card>
      <SafeForm className="space-y-4" pending={pending} onSubmit={onSubmit}>
        {hasPassword ? <CurrentPasswordField id="currentPassword" value={currentPassword} onChange={setCurrentPassword} /> : null}
        <PasswordWithConfirmation
          passwordId="newPassword"
          confirmId="confirmNewPassword"
          passwordLabel={t("new")}
          confirmLabel={t("confirmNew")}
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
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}
        <SubmitButton pending={pending} pendingLabel={t("saving")}>
          {hasPassword ? t("change") : t("set")}
        </SubmitButton>
      </SafeForm>
    </Card>
  );
}
