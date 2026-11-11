"use client";

import { Button, Card, Input } from "@bizora/ui";
import { FormEvent, useEffect, useState } from "react";

type Person = {
  membershipId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  branchId: string | null;
  status: string;
};

export default function SettingsPage() {
  const [org, setOrg] = useState<{ name?: string; primaryColor?: string; accentColor?: string; logoUrl?: string | null }>(
    {},
  );
  const [people, setPeople] = useState<Person[]>([]);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  async function refresh() {
    const [orgRes, peopleRes] = await Promise.all([
      fetch("/api/v1/organizations/current", { credentials: "include" }),
      fetch("/api/v1/memberships", { credentials: "include" }),
    ]);
    const orgJson = await orgRes.json();
    setOrg(orgJson.data?.organization ?? {});
    if (peopleRes.status === 403) {
      setForbidden(true);
      return;
    }
    const peopleJson = await peopleRes.json();
    setPeople(peopleJson.data?.items ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/organizations/current/branding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        primaryColor: form.get("primaryColor"),
        accentColor: form.get("accentColor"),
        logoUrl: form.get("logoUrl") || "",
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not save branding.");
      return;
    }
    setOrg(payload.data.organization);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: form.get("email"),
        role: form.get("role"),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not send invitation.");
      return;
    }
    setInviteToken((payload.data.invitation.token as string | undefined) ?? null);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card>
        <h2 className="font-semibold">Branding</h2>
        <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={saveBrand}>
          <label className="text-sm">
            Primary color
            <Input name="primaryColor" defaultValue={org.primaryColor ?? "#1D4ED8"} className="mt-1" />
          </label>
          <label className="text-sm">
            Accent color
            <Input name="accentColor" defaultValue={org.accentColor ?? "#0F172A"} className="mt-1" />
          </label>
          <label className="text-sm md:col-span-2">
            Logo URL
            <Input name="logoUrl" defaultValue={org.logoUrl ?? ""} className="mt-1" />
          </label>
          <Button type="submit">Save brand</Button>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold">People</h2>
        {forbidden ? (
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            Your role can use the workspace but cannot manage users.
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-2 text-sm">
              {people.map((person) => (
                <li key={person.membershipId}>
                  {person.displayName} ({person.email}) — {person.role}
                </li>
              ))}
            </ul>
            <form className="mt-4 grid gap-3 md:grid-cols-[1fr_160px_auto]" onSubmit={invite}>
              <Input name="email" type="email" placeholder="teammate@business.com" required />
              <select name="role" className="h-10 rounded-md border px-3 text-sm" defaultValue="SALES">
                <option value="ADMINISTRATOR">Administrator</option>
                <option value="MANAGER">Manager</option>
                <option value="SALES">Sales</option>
                <option value="CASHIER">Cashier</option>
                <option value="INVENTORY">Inventory</option>
                <option value="ACCOUNTANT">Accountant</option>
                <option value="EMPLOYEE">Employee</option>
                <option value="AUDITOR">Auditor</option>
              </select>
              <Button type="submit">Invite</Button>
            </form>
            {inviteToken ? (
              <p className="mt-3 break-all text-xs">
                Invite link token (email delivery comes later): {inviteToken}
              </p>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
