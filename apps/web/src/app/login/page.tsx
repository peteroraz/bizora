"use client";

import { Button, Card, Input } from "@bizora/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
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
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to sign in.");
      return;
    }
    if (payload.data?.needsWorkspaceSelection) {
      sessionStorage.setItem("bizora.workspaces", JSON.stringify(payload.data.workspaces ?? []));
      router.push("/select-workspace");
      return;
    }
    const me = await fetch("/api/v1/auth/me", { credentials: "include" }).then((r) => r.json());
    router.push(me.data?.onboardingCompleted === false ? "/app/onboarding" : "/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Sign in to Bizora</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block text-sm">
            Email
            <Input name="email" type="email" autoComplete="email" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Password
            <Input name="password" type="password" autoComplete="current-password" required className="mt-1" />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          New here? <Link href="/register">Create a workspace</Link>
        </p>
      </Card>
    </main>
  );
}
