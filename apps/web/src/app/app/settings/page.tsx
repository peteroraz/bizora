"use client";

import { Card } from "@bizora/ui";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [payload, setPayload] = useState<unknown>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/v1/organizations/current", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/v1/businesses", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/v1/branches", { credentials: "include" }).then((r) => r.json()),
    ]).then(setPayload);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-[hsl(var(--muted-foreground))]">
        Organization, business and branch records for the authenticated tenant. Country packs,
        branding and payment settings expand in Sprint 2.
      </p>
      <Card>
        <pre className="overflow-auto text-xs">{JSON.stringify(payload, null, 2)}</pre>
      </Card>
    </div>
  );
}
