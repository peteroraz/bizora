"use client";

import { Button, Card } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Workspace = {
  organizationId: string;
  organizationName: string;
  role: string;
  businessName: string | null;
  branchName: string | null;
};

export default function SelectWorkspacePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("bizora.workspaces");
    if (stored) setWorkspaces(JSON.parse(stored) as Workspace[]);
  }, []);

  async function choose(organizationId: string) {
    setError(null);
    const response = await fetch("/api/v1/auth/select-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ organizationId }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to open that workspace.");
      return;
    }
    sessionStorage.removeItem("bizora.workspaces");
    const me = await fetch("/api/v1/auth/me", { credentials: "include" }).then((result) => result.json());
    router.push(me.data?.onboardingCompleted === false ? "/app/onboarding" : "/app");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <h1 className="text-2xl font-semibold">Choose a workspace</h1>
        <p className="mt-2 text-sm text-muted">Your account belongs to more than one organization.</p>
        <ul className="mt-6 space-y-3">
          {workspaces.map((workspace) => (
            <li key={workspace.organizationId}>
              <Button type="button" className="w-full" onClick={() => void choose(workspace.organizationId)}>
                {workspace.organizationName} · {workspace.role}
                {workspace.businessName ? ` · ${workspace.businessName}` : ""}
                {workspace.branchName ? ` · ${workspace.branchName}` : ""}
              </Button>
            </li>
          ))}
        </ul>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </Card>
    </main>
  );
}
