"use client";

import {
  Avatar,
  Badge,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  IconButton,
  Select,
  Sheet,
  Tooltip,
  useTheme,
  type ThemeChoice,
} from "@bizora/ui";
import {
  BarChart3,
  Building2,
  ChevronLeft,
  Home,
  Inbox,
  LogOut,
  Menu,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Sparkles,
  Truck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { primaryNav } from "../../lib/nav";

const icons = {
  home: Home,
  sales: ShoppingCart,
  customers: Users,
  products: Package,
  purchasing: Truck,
  expenses: Receipt,
  reports: BarChart3,
  inbox: Inbox,
  ai: Sparkles,
  settings: Settings,
} as const;

export type ShellBusiness = { id: string; name: string };
export type ShellBranch = { id: string; name: string; businessId: string };

export type ShellProfile = {
  user?: { displayName: string; email: string } | null;
  organization?: { name: string } | null;
  tenant?: {
    role: string;
    tenantId: string;
    businessId: string | null;
    branchId: string | null;
  };
  onboardingCompleted?: boolean;
  membership?: { businessId: string | null; branchId: string | null } | null;
  businesses: ShellBusiness[];
  branches: ShellBranch[];
};

function isActive(href: string, pathname: string) {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ profile, children }: { profile: ShellProfile; children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const businessId = profile.tenant?.businessId ?? profile.businesses[0]?.id ?? "";
  const branchId = profile.tenant?.branchId ?? "";
  const visibleBranches = profile.branches.filter((branch) => !businessId || branch.businessId === businessId);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("bizora-sidebar") === "collapsed");
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      window.localStorage.setItem("bizora-sidebar", current ? "expanded" : "collapsed");
      return !current;
    });
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

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    window.location.assign("/login");
  }

  function navigation(compact: boolean) {
    return (
      <nav className="flex flex-col gap-1" aria-label="Primary">
        {primaryNav.map((item) => {
          const Icon = icons[item.icon];
          const active = isActive(item.href, pathname);
          const className = `flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium ${
            active
              ? "bg-sidebar-active text-sidebar-active-fg shadow-[inset_3px_0_0_var(--sidebar-accent)]"
              : "text-sidebar-muted hover:bg-sidebar-active"
          }`;
          const link = (
            <Link href={item.href} aria-current={active ? "page" : undefined} className={className}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {compact ? null : <span className="truncate">{item.label}</span>}
              {!item.enabled && !compact ? <Badge className="ml-auto">Soon</Badge> : null}
            </Link>
          );
          return compact ? (
            <Tooltip key={item.href} content={item.enabled ? item.label : `${item.label}, coming soon`}>
              {link}
            </Tooltip>
          ) : (
            <div key={item.href}>{link}</div>
          );
        })}
      </nav>
    );
  }

  return (
    <div className={collapsed ? "min-h-screen md:grid md:grid-cols-[4.5rem_1fr]" : "min-h-screen md:grid md:grid-cols-[15rem_1fr]"}>
      <aside className="hidden border-r border-border bg-sidebar md:flex md:flex-col">
        <div className="flex items-center justify-between px-3 py-4">
          {collapsed ? null : <Link href="/app" className="px-2 text-lg font-semibold">Bizora</Link>}
          <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} variant="ghost" onClick={toggleCollapsed}>
            <ChevronLeft className={`h-4 w-4 ${collapsed ? "rotate-180" : ""}`} />
          </IconButton>
        </div>
        <div className="px-2">{navigation(collapsed)}</div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-card px-4 py-3">
          <div className="md:hidden">
            <Sheet
              open={menuOpen}
              onOpenChange={setMenuOpen}
              title="Bizora"
              trigger={
                <IconButton label="Open menu" variant="ghost">
                  <Menu className="h-4 w-4" />
                </IconButton>
              }
            >
              {navigation(false)}
            </Sheet>
          </div>
          <div className="hidden min-w-0 items-center gap-2 md:flex">
            <Building2 className="h-4 w-4 text-muted" aria-hidden="true" />
            <span className="truncate text-sm font-medium">{profile.organization?.name ?? "Workspace"}</span>
          </div>
          {profile.businesses.length > 0 ? (
            <Select
              aria-label="Business"
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
          {visibleBranches.length > 0 ? (
            <Select
              aria-label="Branch"
              className="max-w-48"
              value={branchId}
              onChange={(event) => void selectContext(businessId, event.target.value || undefined)}
            >
              {profile.membership?.branchId ? null : <option value="">All branches</option>}
              {visibleBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          ) : null}
          <div className="ml-auto">
            <DropdownMenu
              label="Account"
              trigger={
                <button className="rounded-pill" aria-label="Account menu">
                  <Avatar name={profile.user?.displayName ?? "User"} />
                </button>
              }
            >
              <DropdownLabel>
                <span className="block text-sm font-medium text-fg">{profile.user?.displayName}</span>
                <span className="block">{profile.user?.email}</span>
                <span className="mt-1 block">{profile.tenant?.role}</span>
              </DropdownLabel>
              {(["light", "dark", "system"] as ThemeChoice[]).map((choice) => (
                <DropdownItem key={choice} onSelect={() => setTheme(choice)}>
                  {choice[0]?.toUpperCase()}
                  {choice.slice(1)}
                  {theme === choice ? " · current" : ""}
                </DropdownItem>
              ))}
              <DropdownItem onSelect={() => void logout()}>
                <span className="inline-flex items-center gap-2">
                  <LogOut className="h-4 w-4" aria-hidden="true" /> Log out
                </span>
              </DropdownItem>
            </DropdownMenu>
          </div>
        </header>
        <main className="px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
