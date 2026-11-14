"use client";

import { Button, Card, FormField, Input } from "@bizora/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { OauthButtons } from "../../components/oauth-buttons";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reason = params.get("reason");
  const [error, setError] = useState<string | null>(
    reason === "session"
      ? "Your session expired or was revoked. Sign in again."
      : reason === "link"
        ? "Sign in with your password, then link Google or Microsoft from Settings."
        : reason === "oauth"
          ? "Sign-in could not be completed."
          : reason === "invite"
            ? "That sign-in email does not match the invitation."
            : reason === "email"
              ? "Your provider didn't confirm this email; register with email and password instead"
              : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setError(payload.error?.message ?? "Unable to sign in.");
      return;
    }
    if (payload.data?.needsOrganizationSetup) {
      router.push("/setup");
      return;
    }
    if (payload.data?.needsWorkspaceSelection) {
      sessionStorage.setItem("bizora.workspaces", JSON.stringify(payload.data.workspaces ?? []));
      router.push("/select-workspace");
      return;
    }
    const me = await fetch("/api/v1/auth/me", { credentials: "include" }).then((result) => result.json());
    router.push(me.data?.onboardingCompleted === false ? "/app/onboarding" : "/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Sign in to Bizora</h1>
        <div className="mt-6">
          <OauthButtons returnTo="/app" />
        </div>
        <form className="mt-4 space-y-4" onSubmit={onSubmit}>
          <FormField id="email" label="Email">
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </FormField>
          <FormField id="password" label="Password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </FormField>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          <Link href="/forgot-password" className="font-medium text-primary">
            Forgot password
          </Link>
        </p>
        <p className="mt-4 text-sm">
          New here?{" "}
          <Link href="/register" className="font-medium text-primary">
            Create a workspace
          </Link>
        </p>
      </Card>
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
