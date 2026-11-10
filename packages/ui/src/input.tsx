import type { InputHTMLAttributes } from "react";
import { cn } from "./lib/cn.js";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border bg-transparent px-3 text-sm outline-none ring-[hsl(var(--ring))] focus-visible:ring-2",
        className,
      )}
      {...props}
    />
  );
}
