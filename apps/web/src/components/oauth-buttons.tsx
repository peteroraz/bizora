"use client";

import { buttonVariants } from "@bizora/ui";
import { useEffect, useState } from "react";

type Providers = { google: boolean; microsoft: boolean };

export function OauthButtons({
  returnTo,
  intent,
  token,
}: {
  returnTo: string;
  intent?: "login" | "link" | "invite";
  token?: string;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);

  useEffect(() => {
    void fetch("/api/v1/auth/providers")
      .then((response) => response.json())
      .then((payload: { data?: Providers }) => setProviders(payload.data ?? { google: false, microsoft: false }))
      .catch(() => setProviders({ google: false, microsoft: false }));
  }, []);

  if (!providers?.google && !providers?.microsoft) return null;

  function href(provider: "google" | "microsoft") {
    const params = new URLSearchParams({ returnTo });
    if (intent) params.set("intent", intent);
    if (token) params.set("token", token);
    return `/api/v1/auth/oauth/${provider}/start?${params.toString()}`;
  }

  return (
    <div className="space-y-2">
      {providers.google ? (
        <a className={`${buttonVariants({ variant: "secondary" })} w-full`} href={href("google")}>
          <img src="/providers/google.svg" alt="" width={18} height={18} />
          Continue with Google
        </a>
      ) : null}
      {providers.microsoft ? (
        <a className={`${buttonVariants({ variant: "secondary" })} w-full`} href={href("microsoft")}>
          <img src="/providers/microsoft.svg" alt="" width={18} height={18} />
          Continue with Microsoft
        </a>
      ) : null}
      <p className="text-center text-xs text-muted">or</p>
    </div>
  );
}
