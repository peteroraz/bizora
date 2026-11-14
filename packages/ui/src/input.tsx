import type { InputHTMLAttributes } from "react";
import { cn } from "./lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-control border border-border bg-input px-3 text-sm text-fg outline-none placeholder:text-muted disabled:opacity-50 aria-[invalid=true]:border-danger-border",
        className,
      )}
      {...props}
    />
  );
}
