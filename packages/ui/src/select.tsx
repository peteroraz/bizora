import type { SelectHTMLAttributes } from "react";
import { cn } from "./lib/cn";

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-10 w-full rounded-control border border-border bg-input px-3 text-sm text-fg outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
