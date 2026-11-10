import Link from "next/link";
import { primaryNav } from "../../lib/nav";

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="border-b bg-[hsl(var(--card))] md:border-b-0 md:border-r">
        <div className="px-4 py-4 text-lg font-semibold">Bizora</div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
          {primaryNav.map((item) =>
            item.enabled ? (
              <Link
                key={item.href}
                href={item.href}
                className="whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-[hsl(var(--muted))]"
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.href}
                className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-[hsl(var(--muted-foreground))]"
                title="Available in a later sprint"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>
      </aside>
      <div className="px-4 py-6 md:px-8">{children}</div>
    </div>
  );
}
