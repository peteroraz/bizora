import { buttonVariants, Card } from "@bizora/ui";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-16">
      <p className="text-sm font-semibold tracking-[0.2em] text-primary">BIZORA</p>
      <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">Run your business intelligently.</h1>
      <p className="max-w-2xl text-lg text-muted">
        A multi-tenant workspace for your organization, businesses, and branches. Sales, customers, and AI arrive in later releases.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/register" className={buttonVariants()}>
          Create a workspace
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "secondary" })}>
          Sign in
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <h2 className="font-semibold">Tenant-safe</h2>
          <p className="mt-2 text-sm text-muted">
            Organization context comes from your membership. Client-supplied tenant ids are ignored.
          </p>
        </Card>
        <Card>
          <h2 className="font-semibold">Money-ready</h2>
          <p className="mt-2 text-sm text-muted">Amounts use integer minor units. Floating point never enters the money primitive.</p>
        </Card>
        <Card>
          <h2 className="font-semibold">Installable</h2>
          <p className="mt-2 text-sm text-muted">Use Bizora from a phone or desktop browser. The shell adapts down to a small screen.</p>
        </Card>
      </div>
    </main>
  );
}
