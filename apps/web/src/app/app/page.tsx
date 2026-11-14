"use client";

import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";

type Check = { label: string; done: boolean; href: string };

export default function AppHomePage() {
  const [name, setName] = useState("there");
  const [workspace, setWorkspace] = useState("Loading workspace…");
  const [role, setRole] = useState("—");
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    void (async () => {
      const meResponse = await api("/api/v1/auth/me");
      if (!meResponse.ok) return;
      const me = await meResponse.json();
      if (me.data?.onboardingCompleted === false) {
        window.location.href = "/app/onboarding";
        return;
      }
      const [businessResponse, peopleResponse, inviteResponse] = await Promise.all([
        api("/api/v1/businesses"),
        api("/api/v1/memberships"),
        api("/api/v1/invitations"),
      ]);
      const businesses = businessResponse.ok ? (await businessResponse.json()).data?.items ?? [] : [];
      const people = peopleResponse.ok ? (await peopleResponse.json()).data?.items ?? [] : [];
      const invitations = inviteResponse.ok ? (await inviteResponse.json()).data?.items ?? [] : [];
      const business = businesses[0];
      setName(me.data?.user?.displayName ?? "there");
      setWorkspace(me.data?.organization?.name ?? "Workspace");
      setRole(me.data?.tenant?.role ?? "—");
      setChecks([
        { label: "Business details", done: Boolean(me.data?.onboardingCompleted), href: "/app/settings?tab=business" },
        { label: "Address", done: Boolean(business?.address), href: "/app/settings?tab=business" },
        {
          label: "Invite your team",
          done: people.length > 1 || invitations.length > 0,
          href: "/app/settings?tab=team",
        },
      ]);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${name}`} description={workspace} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">Role</p>
          <p className="mt-1 font-medium">{role}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Workspace</p>
          <p className="mt-1 font-medium">{workspace}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium">Setup</p>
          <ul className="mt-3 space-y-2 text-sm">
            {checks.map((check) => (
              <li key={check.label}>
                <Link href={check.href} className="flex items-center justify-between gap-3">
                  <span>{check.label}</span>
                  <span className={check.done ? "text-success" : "text-muted"}>{check.done ? "Done" : "To do"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
