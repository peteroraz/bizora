"use client";

import { buttonVariants } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useAuthProviders } from "./auth-providers-context";

type Providers = { google: boolean };

export function OauthButtons({
  returnTo,
  intent,
  token,
}: {
  returnTo: string;
  intent?: "login" | "link" | "invite";
  token?: string;
}) {
  const t = useTranslations("oauth");
  // Read on the server with the page when possible; otherwise asked from here.
  const fromServer = useAuthProviders();
  const [providers, setProviders] = useState<Providers | null>(fromServer);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (fromServer) return;
    void fetch("/api/v1/auth/providers")
      .then((response) => response.json())
      .then((payload: { data?: Providers }) => setProviders(payload.data ?? { google: false }))
      .catch(() => setProviders({ google: false }));
  }, [fromServer]);

  // Coming back with the browser's Back button shows the page as it was left: reset the button.
  useEffect(() => {
    const reset = () => setOpening(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  if (!providers?.google) return null;

  const params = new URLSearchParams({ returnTo });
  if (intent) params.set("intent", intent);
  if (token) params.set("token", token);

  return (
    <div className="space-y-2">
      <a
        className={`${buttonVariants({ variant: "secondary" })} w-full`}
        href={`/api/v1/auth/oauth/google/start?${params.toString()}`}
        aria-busy={opening}
        onClick={() => setOpening(true)}
      >
        <img src="/providers/google.svg" alt="" width={18} height={18} />
        {opening ? t("opening") : t("google")}
      </a>
      <p className="text-center text-xs text-muted">{t("or")}</p>
    </div>
  );
}
