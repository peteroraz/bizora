"use client";

import { Button, Card, FormField, Input } from "@bizora/ui";
import Link from "next/link";
import { FormEvent, useState } from "react";

export default function ForgotPasswordPage() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setError(payload.error?.message ?? "Could not send a reset email.");
      return;
    }
    setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Reset your password</h1>
        {sent ? (
          <p className="mt-4 text-sm">If an account exists for that email, a reset link is on its way.</p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={onSubmit}>
            <FormField id="email" label="Email">
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </FormField>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}
        <p className="mt-4 text-sm">
          <Link href="/login" className="font-medium text-primary">
            Back to sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
