import { buttonVariants } from "@bizora/ui";
import Link from "next/link";
import type { ComponentProps } from "react";

/** A link that looks like a button: for actions that open another screen ("Add a product", "New sale"). */
export function ActionLink({ variant = "outline", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: "primary" | "outline" | "secondary" | "ghost"; size?: "sm" | "md" }) {
  return <Link className={buttonVariants({ variant, size, className })} {...props} />;
}

/** "‹ All sales": the way back to a list, as a finger-sized link. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-sm font-medium text-primary hover:bg-sidebar">
      <span aria-hidden="true">‹</span>
      {children}
    </Link>
  );
}
