"use client";

import { buttonVariants } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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
  const [providers, setProviders] = useState<Providers | null>(null);

  useEffect(() => {
    void fetch("/api/v1/auth/providers")
      .then((response) => response.json())
      .then((payload: { data?: Providers }) => setProviders(payload.data ?? { google: false }))
      .catch(() => setProviders({ google: false }));
  }, []);

  if (!providers?.google) return null;

  const params = new URLSearchParams({ returnTo });
  if (intent) params.set("intent", intent);
  if (token) params.set("token", token);

  return (
    <div className="space-y-2">
      <a className={`${buttonVariants({ variant: "secondary" })} w-full`} href={`/api/v1/auth/oauth/google/start?${params.toString()}`}>
        <img src="/providers/google.svg" alt="" width={18} height={18} />
        {t("google")}
      </a>
      <p className="text-center text-xs text-muted">{t("or")}</p>
    </div>
  );
}
