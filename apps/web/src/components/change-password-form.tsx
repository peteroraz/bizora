"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Button, Card } from "@bizora/ui";
import { FormEvent, useState } from "react";
import { confirmPasswordError } from "../lib/password";
import { CurrentPasswordField, PasswordWithConfirmation } from "./password-fields";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const mismatchError = confirmPasswordError(password, confirmation);
    const rulesMet = passwordRules.every((rule) => rule.met(password));
    if (mismatchError || !rulesMet) {
      setMismatch(mismatchError);
      setNotice(null);
      setError(rulesMet ? null : "Choose a password that meets every rule.");
      return;
    }
    setPending(true);
    setError(null);
    setMismatch(null);
    const response = await fetch("/api/v1/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ currentPassword, newPassword: password }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not change the password.");
      return;
    }
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setNotice("Password updated.");
  }

  return (
    <Card>
      <form className="space-y-4" onSubmit={onSubmit}>
        <CurrentPasswordField id="currentPassword" value={currentPassword} onChange={setCurrentPassword} />
        <PasswordWithConfirmation
          passwordId="newPassword"
          confirmId="confirmNewPassword"
          passwordLabel="New password"
          confirmLabel="Confirm new password"
          password={password}
          confirmation={confirmation}
          onPasswordChange={(value) => {
            setPassword(value);
            if (confirmation) setMismatch(confirmPasswordError(value, confirmation));
          }}
          onConfirmationChange={(value) => {
            setConfirmation(value);
            setMismatch(value ? confirmPasswordError(password, value) : null);
          }}
          mismatch={mismatch}
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Change password"}
        </Button>
      </form>
    </Card>
  );
}
