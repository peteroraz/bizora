"use client";

import { Button, Card } from "@bizora/ui";
import { useEffect, useState } from "react";
import { OauthButtons } from "./oauth-buttons";
import { ChangePasswordForm } from "./change-password-form";

type Security = {
  hasPassword: boolean;
  identities: { id: string; provider: string; email: string }[];
  sessions: { id: string; createdAt: string; userAgent: string | null; ip: string | null; current: boolean }[];
};

export function SecurityPanel() {
  const [security, setSecurity] = useState<Security | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/v1/auth/security", { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not load security settings.");
      return;
    }
    setSecurity(payload.data);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function unlink(provider: string) {
    const response = await fetch(`/api/v1/auth/identities/${provider}/unlink`, { method: "POST", credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not unlink that sign-in method.");
      return;
    }
    setNotice(`${provider[0]?.toUpperCase()}${provider.slice(1)} was unlinked.`);
    await refresh();
  }

  async function revokeOthers() {
    const response = await fetch("/api/v1/auth/sessions/revoke-others", { method: "POST", credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not log out the other devices.");
      return;
    }
    setNotice("Other devices were logged out.");
    await refresh();
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Sign-in methods</h2>
        <ul className="space-y-2 text-sm">
          <li>Password: {security?.hasPassword ? "Set" : "Not set"}</li>
          {(security?.identities ?? [])
            .filter((identity) => identity.provider === "google")
            .map((identity) => (
              <li key={identity.id} className="flex flex-wrap items-center gap-2">
                <span>Google: {identity.email}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void unlink(identity.provider)}>
                  Unlink
                </Button>
              </li>
            ))}
        </ul>
        <OauthButtons returnTo="/app/settings?tab=security" intent="link" />
      </Card>
      {security ? <ChangePasswordForm hasPassword={security.hasPassword} /> : null}
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Devices</h2>
        <ul className="space-y-2 text-sm">
          {(security?.sessions ?? []).map((session) => (
            <li key={session.id}>
              {session.current ? "This device" : "Other device"} · {session.userAgent ?? "Unknown browser"} · {session.ip ?? "Unknown address"}
            </li>
          ))}
        </ul>
        <Button type="button" variant="secondary" onClick={() => void revokeOthers()}>
          Log out other devices
        </Button>
      </Card>
    </div>
  );
}
