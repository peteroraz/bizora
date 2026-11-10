"use client";

import { Card } from "@bizora/ui";
import { useEffect, useState } from "react";

type MeResponse = {
  data?: {
    user?: { displayName: string; email: string };
    organization?: { name: string };
    tenant?: { role: string; tenantId: string };
  };
  error?: { message: string };
};

export default function AppHomePage() {
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    void fetch("/api/v1/auth/me", { credentials: "include" })
      .then((response) => response.json())
      .then(setMe);
  }, []);

  if (me?.error) {
    return (
      <Card>
        <p>You are not signed in.</p>
        <a className="mt-3 inline-block text-[hsl(var(--primary))]" href="/login">
          Go to sign in
        </a>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">
          Hello {me?.data?.user?.displayName ?? "there"}
        </h1>
        <p className="text-[hsl(var(--muted-foreground))]">
          {me?.data?.organization?.name ?? "Loading workspace…"}
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Role</p>
          <p className="mt-1 font-medium">{me?.data?.tenant?.role ?? "—"}</p>
        </Card>
        <Card>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Tasks</p>
          <p className="mt-1">No operational tasks yet. Sprint 1 is foundation only.</p>
        </Card>
        <Card>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Ask Zora</p>
          <p className="mt-1">AI assistance is deferred until the AI gateway sprint.</p>
        </Card>
      </div>
    </div>
  );
}
