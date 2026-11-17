"use client";

import { Permission, PIN_LOCKOUT, type AuthWorkspace } from "@bizora/contracts";
import {
  Avatar,
  Badge,
  Button,
  IconButton,
  Select,
  useTheme,
} from "@bizora/ui";
import {
  Banknote,
  BarChart3,
  Building2,
  ChevronLeft,
  HandCoins,
  Home,
  IdCard,
  Lock,
  Menu,
  MoreHorizontal,
  Package,
  Settings,
  ShoppingCart,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import { LazySheet } from "../../components/lazy-sheet";
import { NotificationBell } from "../../components/notification-bell";
import { api } from "../../lib/api";
import type { AccountMenuProps } from "./account-menu";
import { setShopMode } from "../../lib/shop-mode";
import { navAllowed } from "../../lib/access";
import { AccessProvider } from "../../lib/access-context";
import { dismissRejected, subscribe, summary } from "../../lib/offline/outbox";
import { signOutEverywhere } from "../../lib/offline/sw-client";
import { startBackgroundSync } from "../../lib/offline/sync";
import { refreshOfflineCatalog } from "../../lib/stock-client";
import { bottomNav, primaryNav, type NavId } from "../../lib/nav";

const icons = {
  home: Home,
  sales: ShoppingCart,
  customers: Users,
  stock: Package,
  debtors: HandCoins,
  money: Banknote,
  staff: IdCard,
  reports: BarChart3,
  settings: Settings,
} as const;

export type ShellBusiness = {
  id: string;
  name: string;
  visibleModules?: string[] | null;
  staffFeaturesEnabled?: boolean;
  salesFlow?: "simple" | "desk";
};
export type ShellBranch = { id: string; name: string; businessId: string };

export type ShellProfile = {
  user?: { displayName: string; email: string | null; emailVerifiedAt?: string | null; kind?: string } | null;
  organization?: { name: string } | null;
  /** Changes when the company logo changes (ADR-021); null when there is no logo. */
  logoVersion?: string | null;
  tenant?: {
    role: string;
    tenantId: string;
    businessId: string | null;
    branchId: string | null;
    /** Set when a shop staff member signed in with a PIN on an enrolled shop device. */
    deviceId?: string | null;
    /** Loaded from the database for this membership's role. */
    permissions?: string[];
    membershipId?: string;
  };
  onboardingCompleted?: boolean;
  membership?: { businessId: string | null; branchId: string | null } | null;
  businesses: ShellBusiness[];
  branches: ShellBranch[];
  workspaces?: AuthWorkspace[];
};

function isActive(href: string, pathname: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ profile, children }: { profile: ShellProfile; children: React.ReactNode }) {
  const t = useTranslations("shell");
  const nav = useTranslations("nav");
  const roles = useTranslations("roles");
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const businessId = profile.tenant?.businessId ?? profile.businesses[0]?.id ?? "";
  const branchId = profile.tenant?.branchId ?? "";
  const visibleBranches = profile.branches.filter((branch) => !businessId || branch.businessId === businessId);
  const currentBusiness = profile.businesses.find((business) => business.id === businessId) ?? profile.businesses[0];
  const allowed = new Set(
    (currentBusiness?.visibleModules ?? primaryNav.map((item) => item.id)).map((item) => String(item).trim()),
  );
  allowed.add("home");
  allowed.add("customers");
  allowed.add("settings");
  if (currentBusiness?.staffFeaturesEnabled === false) allowed.delete("staff");
  const tenantId = profile.tenant?.tenantId;
  const membershipId = profile.tenant?.membershipId;
  const access = useMemo(
    () => ({
      permissions: profile.tenant?.permissions ?? [],
      staffSession: Boolean(profile.tenant?.deviceId),
      owner: tenantId && membershipId ? { tenantId, membershipId } : null,
      branchId: profile.tenant?.branchId ?? null,
      salesFlow: currentBusiness?.salesFlow === "desk" ? ("desk" as const) : ("simple" as const),
    }),
    [profile.tenant?.permissions, profile.tenant?.deviceId, tenantId, membershipId, profile.tenant?.branchId, currentBusiness?.salesFlow],
  );
  const [outbox, setOutbox] = useState<{ pending: number; rejected: { id: string; error: { message: string } | null }[] }>({
    pending: 0,
    rejected: [],
  });

  // Send work saved offline whenever the device is online, and show what is still waiting.
  useEffect(() => {
    if (!tenantId || !membershipId) return;
    const owner = { tenantId, membershipId };
    const refresh = () => {
      void summary(owner)
        .then((next) => setOutbox({ pending: next.pending, rejected: next.rejected }))
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    const stop = startBackgroundSync(owner);
    return () => {
      unsubscribe();
      stop();
    };
  }, [tenantId, membershipId]);

  // Keep a copy of products and this shop's stock on the phone for looking up with no network.
  const currentBranchId = profile.tenant?.branchId ?? null;
  const readsStock = access.permissions.includes(Permission.STOCK_READ);
  useEffect(() => {
    if (!readsStock || !tenantId || !currentBranchId) return;
    const refresh = () => void refreshOfflineCatalog(tenantId, currentBranchId);
    refresh();
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [readsStock, tenantId, currentBranchId]);
  const items = primaryNav.filter((item) => allowed.has(item.id) && navAllowed(access, item.id));
  const bottom = items.filter((item) => (bottomNav as readonly string[]).includes(item.id));
  const moreItems = items.filter((item) => !(bottomNav as readonly string[]).includes(item.id));

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("bizora-sidebar") === "collapsed");
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      window.localStorage.setItem("bizora-sidebar", current ? "expanded" : "collapsed");
      return !current;
    });
  }

  function label(id: NavId) {
    return nav(id);
  }

  function roleLabel(role: string) {
    return roles.has(role) ? roles(role) : role;
  }

  const [AccountMenu, setAccountMenu] = useState<ComponentType<AccountMenuProps> | null>(null);
  const accountTrigger = (
    <button className="rounded-pill" aria-label={t("accountMenu")}>
      <Avatar name={profile.user?.displayName ?? t("account")} />
    </button>
  );

  const onboarding = pathname.startsWith("/app/onboarding");
  const workspaces = profile.workspaces ?? [];
  const currentOrganizationId = profile.tenant?.tenantId;
  const [logoFailed, setLogoFailed] = useState(false);
  const organizationName = profile.organization?.name ?? t("currentBusiness");

  async function switchWorkspace(organizationId: string) {
    setSwitchError(null);
    const response = await api("/api/v1/auth/select-context", {
      method: "POST",
      body: JSON.stringify({ organizationId }),
    });
    if (response.ok) {
      window.location.assign("/app");
      return;
    }
    const payload = await response.json().catch(() => null);
    setSwitchError(payload?.error?.message ?? t("switchFailed"));
  }

  async function selectContext(nextBusinessId: string, nextBranchId?: string) {
    const response = await api("/api/v1/auth/select-context", {
      method: "POST",
      body: JSON.stringify({
        organizationId: profile.tenant?.tenantId,
        businessId: nextBusinessId,
        ...(nextBranchId ? { branchId: nextBranchId } : {}),
      }),
    });
    if (response.ok) window.location.assign("/app");
  }

  const staffMode = Boolean(profile.tenant?.deviceId);

  async function logout() {
    await signOutEverywhere();
    window.location.assign(staffMode ? "/shop" : "/login");
  }

  // Shop mode: lock back to the staff list after a few minutes without a tap or key press.
  useEffect(() => {
    if (!staffMode) return;
    setShopMode(true);
    let timer = window.setTimeout(() => void logout(), PIN_LOCKOUT.autoLockMinutesDefault * 60_000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void logout(), PIN_LOCKOUT.autoLockMinutesDefault * 60_000);
    };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, reset));
    };
  }, [staffMode]);

  function navigation(compact: boolean) {
    return (
      <nav className="flex flex-col gap-1" aria-label={t("primary")}>
        {items.map((item) => {
          const Icon = icons[item.icon];
          const active = isActive(item.href, pathname);
          const text = label(item.id);
          const className = `flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium ${
            active
              ? "bg-sidebar-active text-sidebar-active-fg shadow-[inset_3px_0_0_var(--sidebar-accent)]"
              : "text-sidebar-muted hover:bg-sidebar-active"
          }`;
          const link = (
            <Link href={item.href} aria-current={active ? "page" : undefined} className={className}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {compact ? null : <span className="truncate">{text}</span>}
              {!item.enabled && !compact ? <Badge className="ml-auto">{t("soon")}</Badge> : null}
            </Link>
          );
          // A native tooltip (title) when the sidebar is collapsed keeps the tooltip library out of every screen.
          return (
            <div key={item.href} title={compact ? (item.enabled ? text : t("comingSoon", { label: text })) : undefined}>
              {link}
            </div>
          );
        })}
      </nav>
    );
  }

  if (onboarding) return (
      <div className="min-h-screen bg-bg">
        <AccessProvider value={access}>{children}</AccessProvider>
      </div>
    );

  return (
    <div className={collapsed ? "min-h-screen md:grid md:grid-cols-[4.5rem_1fr]" : "min-h-screen md:grid md:grid-cols-[15rem_1fr]"}>
      <aside className="hidden border-r border-border bg-sidebar md:flex md:flex-col">
        <div className="flex items-center justify-between px-3 py-4">
          {collapsed ? null : (
            <Link href="/app" className="px-2 text-lg font-semibold">
              {t("menuTitle")}
            </Link>
          )}
          <IconButton label={collapsed ? t("expand") : t("collapse")} variant="ghost" onClick={toggleCollapsed}>
            <ChevronLeft className={`h-4 w-4 ${collapsed ? "rotate-180" : ""}`} />
          </IconButton>
        </div>
        <div className="px-2">{navigation(collapsed)}</div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
          <div className="md:hidden">
            <LazySheet
              open={menuOpen}
              onOpenChange={setMenuOpen}
              title={t("menuTitle")}
              trigger={
                <IconButton label={t("openMenu")} variant="ghost">
                  <Menu className="h-4 w-4" />
                </IconButton>
              }
            >
              {navigation(false)}
            </LazySheet>
          </div>
          <div className="flex min-w-0 max-w-56 items-center gap-2">
            {profile.logoVersion && !logoFailed ? (
              // a private, signed-in picture; next/image cannot fetch it
              <img
                src={`/api/v1/organizations/current/logo?v=${profile.logoVersion}`}
                alt=""
                className="h-8 max-w-16 shrink-0 object-contain"
                data-testid="shell-logo"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <Building2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            )}
            <p className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-primary">{t("currentBusiness")}</span>
              <span className="block truncate text-sm font-semibold">{organizationName}</span>
            </p>
          </div>
          {profile.tenant?.role ? (
            <Badge className="border-primary bg-sidebar-active text-sidebar-active-fg">{roleLabel(profile.tenant.role)}</Badge>
          ) : null}
          {!staffMode && profile.businesses.length > 0 ? (
            <Select
              aria-label={t("business")}
              className="max-w-48"
              value={businessId}
              onChange={(event) => void selectContext(event.target.value)}
            >
              {profile.businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </Select>
          ) : null}
          {staffMode ? (
            <Badge tone="info">
              {t("shopMode")}
              {visibleBranches.find((branch) => branch.id === branchId)?.name
                ? ` · ${visibleBranches.find((branch) => branch.id === branchId)?.name}`
                : ""}
            </Badge>
          ) : null}
          {!staffMode && visibleBranches.length > 0 ? (
            <Select
              aria-label={t("shop")}
              className="max-w-48"
              value={branchId}
              onChange={(event) => void selectContext(businessId, event.target.value || undefined)}
            >
              {profile.membership?.branchId ? null : <option value="">{t("allShops")}</option>}
              {visibleBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            {staffMode ? (
              <button
                type="button"
                onClick={() => void logout()}
                aria-label={t("lockLabel")}
                className="inline-flex h-10 items-center gap-2 rounded-control border border-border px-3 text-sm font-medium"
              >
                <Lock className="h-4 w-4" aria-hidden="true" /> {t("lock")}
              </button>
            ) : null}
            {AccountMenu ? (
              <AccountMenu
                trigger={accountTrigger}
                displayName={profile.user?.displayName}
                email={profile.user?.email}
                roleText={profile.tenant?.role ? roleLabel(profile.tenant.role) : null}
                theme={theme}
                onTheme={setTheme}
                staffMode={staffMode}
                workspaces={workspaces}
                currentOrganizationId={currentOrganizationId}
                onSwitch={(organizationId) => void switchWorkspace(organizationId)}
                onLogout={() => void logout()}
              />
            ) : (
              <span
                className="contents"
                onClickCapture={(event) => {
                  event.preventDefault();
                  void import("./account-menu").then((module) => setAccountMenu(() => module.default));
                }}
              >
                {accountTrigger}
              </span>
            )}
          </div>
          {switchError ? (
            <p className="basis-full text-sm text-danger" role="alert">
              {switchError}
            </p>
          ) : null}
          {outbox.pending > 0 ? (
            <Badge tone="warning" role="status">
              {t("syncWaiting", { count: outbox.pending })}
            </Badge>
          ) : null}
        </header>
        {outbox.rejected.length > 0 && access.owner ? (
          <div className="flex flex-wrap items-start gap-3 border-b border-border bg-card px-4 py-3 text-sm" role="alert">
            <div className="flex-1">
              <p className="font-medium text-danger">{t("syncRejected", { count: outbox.rejected.length })}</p>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {outbox.rejected.map((item) => (
                  <li key={item.id}>{item.error?.message}</li>
                ))}
              </ul>
            </div>
            <Button variant="secondary" onClick={() => access.owner && void dismissRejected(access.owner)}>
              {t("syncDismiss")}
            </Button>
          </div>
        ) : null}
        {profile.user?.emailVerifiedAt === null && !staffMode && profile.user?.email ? <EmailVerificationBanner /> : null}
        <main className="px-4 py-6 pb-24 md:px-8 md:pb-6">
          <AccessProvider value={access}>{children}</AccessProvider>
        </main>
        <nav
          className="fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-card md:hidden"
          style={{ gridTemplateColumns: `repeat(${bottom.length + 1}, minmax(0, 1fr))` }}
          aria-label={t("mobile")}
        >
          {bottom.map((item) => {
            const Icon = icons[item.icon];
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium ${active ? "text-primary" : "text-muted"}`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {label(item.id)}
              </Link>
            );
          })}
          <LazySheet
            open={moreOpen}
            onOpenChange={setMoreOpen}
            title={t("more")}
            trigger={
              <button type="button" className="flex flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium text-muted">
                <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
                {t("more")}
              </button>
            }
          >
            <div className="flex flex-col gap-1">
              {moreItems.map((item) => (
                <Link key={item.href} href={item.href} className="rounded-control px-3 py-2 text-sm font-medium">
                  {label(item.id)}
                </Link>
              ))}
            </div>
          </LazySheet>
        </nav>
      </div>
    </div>
  );
}

function EmailVerificationBanner() {
  const t = useTranslations("shell");
  const [notice, setNotice] = useState<string | null>(null);

  async function resend() {
    const response = await api("/api/v1/auth/email/verification", { method: "POST" });
    const payload = await response.json();
    setNotice(response.ok ? t("resendOk") : (payload.error?.message ?? t("resendFailed")));
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-warning-bg px-4 py-3 text-sm text-fg">
      <p>{t("verify")}</p>
      <button type="button" className="font-medium text-primary" onClick={() => void resend()}>
        {t("resend")}
      </button>
      {notice ? <span>{notice}</span> : null}
    </div>
  );
}
