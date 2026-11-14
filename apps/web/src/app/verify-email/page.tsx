"use client";

import { Button, Card } from "@bizora/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function VerifyEmail() {
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
      setError(payload.error?.message ?? "That verification link is invalid or has expired.");
      return;
    }
    setMessage("Your email is verified.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full space-y-4">
        <h1 className="text-2xl font-semibold">Verify your email</h1>
        {message ? <p className="text-sm">{message}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? null : (
          <Button type="button" disabled={pending || !token} onClick={() => void confirm()}>
            {pending ? "Verifying…" : "Confirm email"}
          </Button>
        )}
        <p className="text-sm">
          <Link href="/app" className="font-medium text-primary">
            Continue to Bizora
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
