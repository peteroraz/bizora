"use client";

import { Button, Skeleton } from "@bizora/ui";
import { adminCan } from "@bizora/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AdminApiError, adminApi, type AdminMe } from "@/lib/admin-api";
import { AdminContext } from "@/lib/admin-context";
import { SignIn } from "./sign-in";

export { useAdmin, useCan } from "@/lib/admin-context";

type State = { kind: "loading" } | { kind: "signedOut" } | { kind: "unreachable" } | { kind: "signedIn"; me: AdminMe };

export function AdminShell({ environment, children }: { environment: string; children: ReactNode }) {
  const t = useTranslations("shell");
  const [state, setState] = useState<State>({ kind: "loading" });
  const pathname = usePathname();

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "signedIn", me: await adminApi<AdminMe>("/auth/me") });
    } catch (error) {
      setState(error instanceof AdminApiError && error.status === 401 ? { kind: "signedOut" } : { kind: "unreachable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    await adminApi("/auth/sign-out", { method: "POST" }).catch(() => undefined);
    window.location.assign("/");
  }

  const band =
    environment === "production" ? null : (
      <div className="bg-[var(--admin-env)] px-4 py-1 text-center text-xs font-semibold text-[var(--admin-env-fg)]">
        {t("environment", { environment: environment.charAt(0).toUpperCase() + environment.slice(1) })}
      </div>
    );

  if (state.kind !== "signedIn") {
    return (
      <div className="min-h-screen">
        {band}
        {state.kind === "loading" ? (
          <main className="mx-auto max-w-md space-y-3 px-4 py-24" aria-busy="true">
            <p className="sr-only">{t("loading")}</p>
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-24 w-full" />
          </main>
        ) : state.kind === "unreachable" ? (
          <main className="mx-auto max-w-md space-y-4 px-4 py-24">
            <p role="alert">{t("unreachable")}</p>
            <Button onClick={() => void load()}>{t("retry")}</Button>
          </main>
        ) : (
          <SignIn />
        )}
      </div>
    );
  }

  const me = state.me;
  const links = [
    { href: "/", label: t("nav.find"), show: true, active: pathname === "/" || pathname.startsWith("/businesses") || pathname.startsWith("/people") },
    { href: "/staff", label: t("nav.staff"), show: adminCan(me.roles, "staff.manage"), active: pathname.startsWith("/staff") },
    { href: "/audit", label: t("nav.audit"), show: adminCan(me.roles, "audit.read"), active: pathname.startsWith("/audit") },
  ];
  return (
    <AdminContext.Provider value={me}>
      <div className="min-h-screen">
        {band}
        <header className="bg-[var(--admin-bar)] text-[var(--admin-bar-fg)]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              {t("portal")}
            </Link>
            <nav className="flex gap-1" aria-label={t("portal")}>
              {links
                .filter((link) => link.show)
                .map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={link.active ? "page" : undefined}
                    className={`rounded-control px-3 py-1.5 text-sm ${link.active ? "bg-white/15 font-medium" : "text-[var(--admin-bar-muted)] hover:bg-white/10"}`}
                  >
                    {link.label}
                  </Link>
                ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-[var(--admin-bar-muted)]">{t("signedInAs", { email: me.email })}</span>
              <button type="button" onClick={() => void signOut()} className="rounded-control px-3 py-1.5 hover:bg-white/10">
                {t("signOut")}
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>
    </AdminContext.Provider>
  );
}
