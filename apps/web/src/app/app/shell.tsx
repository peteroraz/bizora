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
  ChevronDown,
  ChevronLeft,
  HandCoins,
  Truck,
  Home,
  IdCard,
  Lock,
  Menu,
  MoreHorizontal,
  Package,
  Settings,
  ShoppingCart,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import { LazySheet } from "../../components/lazy-sheet";
import { NotificationBell } from "../../components/notification-bell";
import { api } from "../../lib/api";
import type { AccountMenuProps } from "./account-menu";
import { setShopMode } from "../../lib/shop-mode";
import { navAllowed } from "../../lib/access";
import { AccessProvider } from "../../lib/access-context";
import { signOutEverywhere } from "../../lib/offline/sw-client";
import { bottomItemsFor, primaryNav, type NavId } from "../../lib/nav";

const icons = {
  home: Home,
  sales: ShoppingCart,
  jobs: Wrench,
  customers: Users,
  stock: Package,
  debtors: HandCoins,
  suppliers: Truck,
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
  salesItems?: "products" | "typed" | "both";
  amountSales?: boolean;
  countryCode?: string;
  baseCurrencyCode?: string;
  timezone?: string;
};
export type ShellBranch = { id: string; name: string; businessId: string };

export type ShellProfile = {
  user?: { displayName: string; email: string | null; emailVerifiedAt?: string | null; kind?: string } | null;
  organization?: { name: string; isSample?: boolean } | null;
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
  /** Switches for this business (ADR-045). Missing: as before. */
  features?: Partial<Record<"offline_voice" | "photo_reads" | "support_view", boolean>>;
  membership?: { businessId: string | null; branchId: string | null; defaultBranchId?: string | null } | null;
  businesses: ShellBusiness[];
  branches: ShellBranch[];
  workspaces?: AuthWorkspace[];
};

function isActive(href: string, pathname: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ profile, children, banner }: { profile: ShellProfile; children: React.ReactNode; banner?: React.ReactNode }) {
  const t = useTranslations("shell");
  const nav = useTranslations("nav");
  const roles = useTranslations("roles");
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
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
      ...(profile.tenant?.role ? { role: profile.tenant.role } : {}),
      staffSession: Boolean(profile.tenant?.deviceId),
      // The shop goes with the owner, so work saved offline keeps the shop it was done in (ADR-044).
      owner: tenantId && membershipId ? { tenantId, membershipId, ...(profile.tenant?.branchId ? { branchId: profile.tenant.branchId } : {}) } : null,
      branchId: profile.tenant?.branchId ?? null,
      membershipBranchId: profile.membership?.branchId ?? null,
      salesFlow: currentBusiness?.salesFlow === "desk" ? ("desk" as const) : ("simple" as const),
      salesItems: currentBusiness?.salesItems ?? "products",
      amountSales: currentBusiness?.amountSales === true,
      ...(currentBusiness?.countryCode ? { country: currentBusiness.countryCode.trim() } : {}),
      ...(currentBusiness?.baseCurrencyCode ? { currency: currentBusiness.baseCurrencyCode.trim() } : {}),
      ...(currentBusiness?.timezone ? { timezone: currentBusiness.timezone } : {}),
      offlineVoice: profile.features?.offline_voice !== false,
    }),
    [
      profile.tenant?.permissions,
      profile.tenant?.role,
      profile.tenant?.deviceId,
      tenantId,
      membershipId,
      profile.tenant?.branchId,
      currentBusiness?.salesFlow,
      currentBusiness?.salesItems,
      currentBusiness?.amountSales,
      currentBusiness?.countryCode,
      currentBusiness?.baseCurrencyCode,
      currentBusiness?.timezone,
      profile.features?.offline_voice,
    ],
  );
  // Waiting sales load after the screen has opened, so they are not part of the first script (quick sale budget).
  const syncSlot = useRef<HTMLSpanElement>(null);
  const [SyncStatus, setSyncStatus] = useState<ComponentType<{ owner: { tenantId: string; membershipId: string } | null; isSample: boolean; buttonHost: HTMLElement | null }> | null>(null);
  useEffect(() => {
    const load = () => void import("./sync-status").then((module) => setSyncStatus(() => module.SyncStatus));
    if (document.readyState === "complete") window.setTimeout(load, 0);
    else window.addEventListener("load", () => window.setTimeout(load, 0), { once: true });
  }, []);

  // Keep a copy of products and this shop's stock on the phone for looking up with no network.
  const currentBranchId = profile.tenant?.branchId ?? null;
  const readsStock = access.permissions.includes(Permission.STOCK_READ);
  useEffect(() => {
    if (!readsStock || !tenantId || !currentBranchId) return;
    const refresh = () => void import("../../lib/stock-client").then((stock) => stock.refreshOfflineCatalog(tenantId, currentBranchId));
    refresh();
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [readsStock, tenantId, currentBranchId]);
  // Modules that are not built yet stay out of the menu until they are.
  const items = primaryNav.filter((item) => item.enabled && allowed.has(item.id) && navAllowed(access, item.id));
  const { bottom, more: moreItems } = bottomItemsFor(profile.tenant?.role, items);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("bizora-sidebar") === "collapsed");
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
    setPlaceOpen(false);
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
    <button className="flex h-11 w-11 items-center justify-center rounded-pill" aria-label={t("accountMenu")}>
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
  const [defaultShop, setDefaultShop] = useState(profile.membership?.defaultBranchId ?? null);
  const placeName = visibleBranches.find((branch) => branch.id === branchId)?.name ?? (branchId ? "" : visibleBranches.length > 1 ? t("allShops") : (visibleBranches[0]?.name ?? ""));
  // Staff tied to one shop, and owners with one shop, have nothing to switch.
  const canSwitchPlace = !staffMode && (profile.businesses.length > 1 || (visibleBranches.length > 1 && !profile.membership?.branchId));

  async function logout() {
    await signOutEverywhere();
    window.location.assign(staffMode ? "/shop" : "/login");
  }

  // Shop mode: lock back to the staff list after a few minutes without a tap, key press or scroll. A warning
  // shows first, so someone reading a long list or waiting for a customer can keep the screen with one tap.
  const [lockWarning, setLockWarning] = useState(false);
  useEffect(() => {
    if (!staffMode) return;
    setShopMode(true);
    const lockAfter = PIN_LOCKOUT.autoLockMinutesDefault * 60_000;
    let warnTimer = 0;
    let lockTimer = 0;
    const reset = () => {
      window.clearTimeout(warnTimer);
      window.clearTimeout(lockTimer);
      setLockWarning(false);
      warnTimer = window.setTimeout(() => setLockWarning(true), lockAfter - AUTO_LOCK_WARNING_MS);
      lockTimer = window.setTimeout(() => void logout(), lockAfter);
    };
    reset();
    // Capture phase: scrolling inside a list or a sheet never reaches the window otherwise.
    const events = ["pointerdown", "keydown", "touchstart", "scroll", "wheel", "input"] as const;
    events.forEach((name) => document.addEventListener(name, reset, { capture: true, passive: true }));
    return () => {
      window.clearTimeout(warnTimer);
      window.clearTimeout(lockTimer);
      events.forEach((name) => document.removeEventListener(name, reset, { capture: true }));
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
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 md:px-6">
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
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
              <Building2 className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            )}
            {canSwitchPlace ? (
              <LazySheet
                open={placeOpen}
                onOpenChange={setPlaceOpen}
                title={t("switchPlace")}
                trigger={
                  <button type="button" className="flex min-h-11 min-w-0 items-center gap-1 rounded-control px-1 text-left" aria-label={t("switchPlaceLabel", { place: placeName })} data-testid="place-chip">
                    <PlaceText organization={organizationName} place={placeName} />
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  </button>
                }
              >
                <div className="space-y-4">
                  {profile.businesses.length > 1 ? (
                    <label className="block space-y-1 text-sm font-medium">
                      <span>{t("business")}</span>
                      <Select value={businessId} onChange={(event) => void selectContext(event.target.value)}>
                        {profile.businesses.map((business) => (
                          <option key={business.id} value={business.id}>
                            {business.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : null}
                  {visibleBranches.length > 0 ? (
                    <label className="block space-y-1 text-sm font-medium">
                      <span>{t("shop")}</span>
                      <Select value={branchId} onChange={(event) => void selectContext(businessId, event.target.value || undefined)}>
                        {profile.membership?.branchId ? null : <option value="">{t("allShops")}</option>}
                        {visibleBranches.map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : null}
                  {branchId && !profile.membership?.branchId && membershipId ? (
                    // The shop Bizora opens in next time (ADR-032).
                    defaultShop === branchId ? (
                      <p className="text-sm text-muted">{t("opensHere")}</p>
                    ) : (
                      <button
                        type="button"
                        className="min-h-11 text-sm font-medium text-primary"
                        onClick={() =>
                          void api(`/api/v1/memberships/${membershipId}/default-shop`, { method: "PUT", body: JSON.stringify({ branchId }) }).then((response) => {
                            if (response.ok) setDefaultShop(branchId);
                          })
                        }
                      >
                        {t("openHere")}
                      </button>
                    )
                  ) : null}
                </div>
              </LazySheet>
            ) : (
              <div className="min-w-0 px-1">
                <PlaceText organization={organizationName} place={staffMode ? `${t("shopMode")}${placeName ? ` · ${placeName}` : ""}` : placeName} />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
          <span ref={syncSlot} className="contents" />
        </header>
        {SyncStatus ? <SyncStatus owner={access.owner ?? null} isSample={profile.organization?.isSample === true} buttonHost={syncSlot.current} /> : null}
        {lockWarning ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="alert" data-testid="lock-warning">
            <p className="flex-1 font-medium">{t("lockSoon")}</p>
            {/* Any tap already keeps the screen; the button says so. */}
            <Button variant="secondary" onClick={() => setLockWarning(false)}>
              {t("keepWorking")}
            </Button>
          </div>
        ) : null}
        {profile.user?.emailVerifiedAt === null && !staffMode && profile.user?.email && pathname === "/app" ? <EmailVerificationBanner /> : null}
        {banner}
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
                className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-medium ${active ? "text-primary" : "text-muted"}`}
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
              <button type="button" className="flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-medium text-muted">
                <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
                {t("more")}
              </button>
            }
          >
            <div className="flex flex-col gap-1">
              {moreItems.map((item) => (
                <Link key={item.href} href={item.href} className="flex min-h-11 items-center rounded-control px-3 text-base font-medium hover:bg-sidebar-active">
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

const BANNER_KEY = "bizora.verifyBannerHiddenUntil";

/** Shown on Home only. The owner can hide it for a week. */
function EmailVerificationBanner() {
  const t = useTranslations("shell");
  const [notice, setNotice] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      setHidden(Number(window.localStorage.getItem(BANNER_KEY) ?? 0) > Date.now());
    } catch {
      setHidden(false);
    }
  }, []);

  async function resend() {
    const response = await api("/api/v1/auth/email/verification", { method: "POST" });
    const payload = await response.json();
    setNotice(response.ok ? t("resendOk") : (payload.error?.message ?? t("resendFailed")));
  }

  function hide() {
    setHidden(true);
    try {
      window.localStorage.setItem(BANNER_KEY, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
    } catch {
      // Hiding is a convenience; it simply shows again next time.
    }
  }

  if (hidden) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-warning-bg px-4 py-2 text-sm text-fg" data-testid="verify-banner">
      <p className="flex-1">{t("verify")}</p>
      <button type="button" className="min-h-11 font-medium text-primary" onClick={() => void resend()}>
        {t("resend")}
      </button>
      <button type="button" className="min-h-11 text-muted" onClick={hide}>
        {t("hideForNow")}
      </button>
      {notice ? <span className="basis-full">{notice}</span> : null}
    </div>
  );
}

/** How long before the shop screen locks the warning shows. */
const AUTO_LOCK_WARNING_MS = 30_000;

function PlaceText({ organization, place }: { organization: string; place: string }) {
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-semibold leading-tight">{organization}</span>
      {place ? <span className="block truncate text-xs text-muted">{place}</span> : null}
    </span>
  );
}
