"use client";

import type { AuthWorkspace } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, Skeleton } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRole } from "../../lib/role-label";

type LoadState = "loading" | "ready" | "error";

function workspaceDetail(workspace: AuthWorkspace) {
  return [workspace.businessName, workspace.branchName].filter((part): part is string => Boolean(part)).join(" · ");
}

export default function SelectWorkspacePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<AuthWorkspace[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    setError(null);

    void (async () => {
      try {
        const response = await fetch("/api/v1/auth/workspaces", {
          credentials: "include",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          router.replace("/login?reason=session");
          return;
        }
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(payload?.data)) {
          setLoadState("error");
          setError(payload?.error?.message ?? "Unable to load your workspaces.");
          return;
        }
        setWorkspaces(payload.data as AuthWorkspace[]);
        setLoadState("ready");
      } catch {
        if (controller.signal.aborted) return;
        setLoadState("error");
        setError("Unable to load your workspaces.");
      }
    })();

    return () => controller.abort();
  }, [requestId, router]);

  async function choose(organizationId: string) {
    setError(null);
    setPendingId(organizationId);
    const response = await fetch("/api/v1/auth/select-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ organizationId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setPendingId(null);
      setError(payload?.error?.message ?? "Unable to open that workspace.");
      return;
    }
    const me = await fetch("/api/v1/auth/me", { credentials: "include" }).then((result) => result.json());
    router.push(me.data?.onboardingCompleted === false ? "/app/onboarding" : "/app");
  }

  async function signOut() {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    router.push("/login");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
      <div className="w-full">
        <p className="text-sm font-semibold tracking-[0.2em] text-primary">BIZORA</p>
        <h1 className="mt-2 text-2xl font-semibold text-fg">Choose a workspace</h1>
        <p className="mt-2 text-sm text-muted">Open the organization you want to work in.</p>

        {loadState === "loading" ? (
          <div className="mt-6 space-y-3" aria-busy="true" aria-label="Loading workspaces">
            <Skeleton className="h-24 w-full rounded-card" />
            <Skeleton className="h-24 w-full rounded-card" />
          </div>
        ) : null}

        {loadState === "error" ? (
          <Card className="mt-6">
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
            <Button type="button" className="mt-4" onClick={() => setRequestId((current) => current + 1)}>
              Try again
            </Button>
          </Card>
        ) : null}

        {loadState === "ready" && workspaces.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="No workspaces yet"
              description="This account is not an active member of any organization."
              action={
                <Button type="button" onClick={() => void signOut()}>
                  Sign out
                </Button>
              }
            />
          </div>
        ) : null}

        {loadState === "ready" && workspaces.length > 0 ? (
          <ul className="mt-6 space-y-3">
            {workspaces.map((workspace) => {
              const detail = workspaceDetail(workspace);
              return (
                <li key={`${workspace.organizationId}:${workspace.role}`}>
                  <Card className="overflow-hidden p-0 transition hover:border-primary">
                    <button
                      type="button"
                      className="flex w-full flex-col gap-3 border-l-4 border-primary p-5 text-left hover:bg-sidebar-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:opacity-50"
                      onClick={() => void choose(workspace.organizationId)}
                      disabled={pendingId !== null}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="text-base font-semibold text-fg">{workspace.organizationName}</span>
                        <Badge className="shrink-0 border-primary bg-sidebar-active text-sidebar-active-fg">
                          {formatRole(workspace.role)}
                        </Badge>
                      </span>
                      {detail ? <span className="text-sm text-muted">{detail}</span> : null}
                    </button>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}

        {loadState === "ready" && error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
