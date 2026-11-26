import { cookies, headers } from "next/headers";
import { earlyRequestScript } from "../../lib/early-requests";
import { redirect } from "next/navigation";
import { WorkBanner, type WorkStatus } from "../../components/work-banner";
import { VERIFY_BANNER_COOKIE } from "../../lib/verify-banner";
import { AppShell, type ShellProfile } from "./shell";

const origin = process.env.API_ORIGIN ?? "http://localhost:3001";

async function load(path: string, cookie: string) {
  return fetch(`${origin}${path}`, { headers: { cookie }, cache: "no-store" });
}

export default async function AppShellLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const cookie = jar.toString();
  const meResponse = await load("/api/v1/auth/me", cookie);
  // A shop device goes back to the staff PIN screen, everyone else to the sign-in page.
  if (meResponse.status === 401) redirect(jar.has("bizora_device") ? "/shop" : "/login?reason=session");
  if (!meResponse.ok) redirect("/login");
  const me = (await meResponse.json()) as { data: Omit<ShellProfile, "businesses" | "branches"> & { termsRequired?: boolean } };
  // Owners accept the Terms of use before anything else (ADR-039).
  if (me.data.termsRequired) redirect("/accept-terms");
  const [businessResponse, branchResponse, brandResponse, workResponse] = await Promise.all([
    load("/api/v1/businesses", cookie),
    load("/api/v1/branches", cookie),
    load("/api/v1/organizations/current/branding", cookie),
    // Shop lock and opening hours (ADR-034), for the banner staff see.
    load("/api/v1/work-rules/status", cookie).catch(() => null),
  ]);
  const businesses = businessResponse.ok ? ((await businessResponse.json()).data?.items ?? []) : [];
  const branches = branchResponse.ok ? ((await branchResponse.json()).data?.items ?? []) : [];
  const logoVersion: string | null = brandResponse.ok ? ((await brandResponse.json()).data?.branding?.logo?.version ?? null) : null;
  const work: WorkStatus | null = workResponse?.ok ? ((await workResponse.json()).data ?? null) : null;
  const businessId = (me.data as { tenant?: { businessId?: string | null } }).tenant?.businessId;
  const timeZone = (businesses as { id: string; timezone?: string }[]).find((business) => business.id === businessId)?.timezone ?? "UTC";
  // The content security policy allows only scripts carrying this page's nonce (ADR-036).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Hidden for a week from the banner itself; kept in a cookie so the page is drawn without it (ADR-072).
  const verifyBannerHidden = jar.has(VERIFY_BANNER_COOKIE);
  return (
    <>
      {/* Starts this screen's first requests while its scripts download (ADR-072). */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: earlyRequestScript() }} />
      <AppShell profile={{ ...me.data, businesses, branches, logoVersion, verifyBannerHidden }} banner={<WorkBanner status={work} timeZone={timeZone} />}>
        {children}
      </AppShell>
    </>
  );
}
