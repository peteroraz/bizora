import type { HTMLAttributes } from "react";
import { cn } from "./lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // 16 px inside on phones, 24 px from the small breakpoint up. A card given its own padding keeps it at every size.
  const ownPadding = typeof className === "string" && /(^|\s)p-\S+/.test(className);
  return <div className={cn("rounded-card border border-border bg-card text-fg shadow-sm", ownPadding ? null : "p-4 sm:p-6", className)} {...props} />;
}
