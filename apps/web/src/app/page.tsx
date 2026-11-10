import Link from "next/link";
import { Button, Card } from "@bizora/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <p className="text-sm font-semibold tracking-[0.2em] text-[hsl(var(--primary))]">BIZORA</p>
      <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
        Run your business intelligently.
      </h1>
      <p className="max-w-2xl text-lg text-[hsl(var(--muted-foreground))]">
        Sprint 1 establishes the multi-tenant operating platform: authentication, organization /
        business / branch membership, and a responsive shell. CRM, invoices, payments and AI land in
        later sprints.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/register">
          <Button>Create a workspace</Button>
        </Link>
        <Link href="/login">
          <Button variant="outline">Sign in</Button>
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <h2 className="font-semibold">Tenant-safe</h2>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            Organization context is derived on the server from your membership, never from a client-only ID.
          </p>
        </Card>
        <Card>
          <h2 className="font-semibold">Money-ready</h2>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            Amounts use integer minor units. Floating point is banned from the money primitive.
          </p>
        </Card>
        <Card>
          <h2 className="font-semibold">Installable PWA</h2>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            Use Bizora from a phone or desktop browser. Native apps are intentionally later.
          </p>
        </Card>
      </div>
    </main>
  );
}
