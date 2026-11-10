import type { HTMLAttributes } from "react";
import { cn } from "./lib/cn.js";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-[hsl(var(--card))] p-6 text-[hsl(var(--card-foreground))] shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
