import type { HTMLAttributes } from "react";
import { cn } from "./lib/cn";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-control bg-sidebar", className)} {...props} />;
}
