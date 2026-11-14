"use client";

import { passwordRules } from "@bizora/contracts/password";
import { Button, Card } from "@bizora/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { PasswordWithConfirmation } from "../../components/password-fields";
import { confirmPasswordError } from "../../lib/password";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const mismatchError = confirmPasswordError(password, confirmation);
    const rulesMet = passwordRules.every((rule) => rule.met(password));
    if (mismatchError || !rulesMet) {
      setMismatch(mismatchError);
      setError(rulesMet ? null : "Choose a password that meets every rule.");
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
      setError(payload.error?.message ?? "That reset link is invalid or has expired.");
      return;
    }
    router.push("/login");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Choose a new password</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <PasswordWithConfirmation
            passwordId="password"
            confirmId="confirmPassword"
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
          <Button type="submit" disabled={pending || !token} className="w-full">
            {pending ? "Saving…" : "Update password"}
          </Button>
        </form>
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
