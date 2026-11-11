"use client";

import { Button, Card, Input } from "@bizora/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";

function InviteForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: form.get("token"),
        displayName: form.get("displayName"),
        password: form.get("password"),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setPending(false);
      setError(payload.error?.message ?? "Invitation could not be accepted.");
      return;
    }
    const login = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: payload.data.user.email,
        password: form.get("password"),
      }),
    });
    setPending(false);
    if (!login.ok) {
      router.push("/login");
      return;
    }
    router.push("/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Join a Bizora workspace</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <input type="hidden" name="token" value={token} />
          <label className="block text-sm">
            Your name
            <Input name="displayName" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Password (12+ characters)
            <Input name="password" type="password" minLength={12} required className="mt-1" />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={pending || !token} className="w-full">
            {pending ? "Joining…" : "Accept invitation"}
          </Button>
        </form>
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
