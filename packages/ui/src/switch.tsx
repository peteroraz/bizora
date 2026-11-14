"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "./lib/cn";

export function Switch({
  label,
  className,
  ...props
}: SwitchPrimitive.SwitchProps & { label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-fg">
      <SwitchPrimitive.Root
        aria-label={label}
        className={cn(
          "relative h-6 w-11 rounded-pill border border-border bg-secondary data-[state=checked]:bg-primary",
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-pill bg-card shadow-xs transition data-[state=checked]:translate-x-5" />
      </SwitchPrimitive.Root>
      {label}
    </label>
  );
}
