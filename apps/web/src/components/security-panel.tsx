"use client";

import { Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { OauthButtons } from "./oauth-buttons";
import { ChangePasswordForm } from "./change-password-form";

type Security = {
  hasPassword: boolean;
  identities: { id: string; provider: string; email: string }[];
  sessions: { id: string; createdAt: string; userAgent: string | null; ip: string | null; current: boolean }[];
};

export function SecurityPanel() {
  const t = useTranslations("security");
  const [security, setSecurity] = useState<Security | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/v1/auth/security", { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? t("loadFailed"));
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
      setError(payload.error?.message ?? t("unlinkFailed"));
      return;
    }
    const label = `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
    setNotice(t("unlinked", { provider: label }));
    await refresh();
  }

  async function revokeOthers() {
    const response = await fetch("/api/v1/auth/sessions/revoke-others", { method: "POST", credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? t("logoutFailed"));
      return;
    }
    setNotice(t("loggedOut"));
    await refresh();
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("methods")}</h2>
        <ul className="space-y-2 text-sm">
          <li>{t("passwordState", { state: security?.hasPassword ? t("set") : t("notSet") })}</li>
          {(security?.identities ?? [])
            .filter((identity) => identity.provider === "google")
            .map((identity) => (
              <li key={identity.id} className="flex flex-wrap items-center gap-2">
                <span>{t("google", { email: identity.email })}</span>
                <button type="button" className="font-medium text-primary" onClick={() => void unlink(identity.provider)}>
                  {t("unlink")}
                </button>
              </li>
            ))}
        </ul>
        <OauthButtons returnTo="/app/settings?tab=security" intent="link" />
      </Card>
      {security ? <ChangePasswordForm hasPassword={security.hasPassword} /> : null}
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("devices")}</h2>
        <ul className="space-y-2 text-sm">
          {(security?.sessions ?? []).map((session) => (
            <li key={session.id}>
              {session.current ? t("thisDevice") : t("otherDevice")} · {session.userAgent ?? t("unknownBrowser")} · {session.ip ?? t("unknownAddress")}
            </li>
          ))}
        </ul>
        <button type="button" className="rounded-control border border-border px-3 py-2 text-sm font-medium" onClick={() => void revokeOthers()}>
          {t("logoutOthers")}
        </button>
      </Card>
    </div>
  );
}
