import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell, type ShellProfile } from "./shell";

const origin = process.env.API_ORIGIN ?? "http://localhost:3001";

async function load(path: string, cookie: string) {
  return fetch(`${origin}${path}`, { headers: { cookie }, cache: "no-store" });
}

export default async function AppShellLayout({ children }: { children: React.ReactNode }) {
  const cookie = (await cookies()).toString();
  const meResponse = await load("/api/v1/auth/me", cookie);
  if (meResponse.status === 401) redirect("/login?reason=session");
  if (!meResponse.ok) redirect("/login");
  const me = (await meResponse.json()) as { data: Omit<ShellProfile, "businesses" | "branches"> };
  const [businessResponse, branchResponse] = await Promise.all([
    load("/api/v1/businesses", cookie),
    load("/api/v1/branches", cookie),
  ]);
  const businesses = businessResponse.ok ? ((await businessResponse.json()).data?.items ?? []) : [];
  const branches = branchResponse.ok ? ((await branchResponse.json()).data?.items ?? []) : [];
  return <AppShell profile={{ ...me.data, businesses, branches }}>{children}</AppShell>;
}
