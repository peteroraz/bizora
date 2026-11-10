"use client";

import { Button, Card, Input } from "@bizora/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        displayName: form.get("displayName"),
        organizationName: form.get("organizationName"),
        countryCode: form.get("countryCode"),
        baseCurrencyCode: form.get("baseCurrencyCode"),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to create workspace.");
      return;
    }
    router.push("/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-8">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Create your Bizora workspace</h1>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block text-sm">
            Your name
            <Input name="displayName" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Business name
            <Input name="organizationName" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Email
            <Input name="email" type="email" required className="mt-1" />
          </label>
          <label className="block text-sm">
            Password (12+ characters)
            <Input name="password" type="password" minLength={12} required className="mt-1" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Country
              <Input name="countryCode" defaultValue="NG" maxLength={2} required className="mt-1" />
            </label>
            <label className="block text-sm">
              Currency
              <Input name="baseCurrencyCode" defaultValue="NGN" maxLength={3} required className="mt-1" />
            </label>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          Already registered? <Link href="/login">Sign in</Link>
        </p>
      </Card>
    </main>
  );
}
