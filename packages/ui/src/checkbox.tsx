"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "./lib/cn";

export function Checkbox({
  label,
  className,
  ...props
}: CheckboxPrimitive.CheckboxProps & { label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-fg">
      <CheckboxPrimitive.Root
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-[4px] border border-border bg-input data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-fg",
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator>
          <Check className="h-3 w-3" aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label}
    </label>
  );
}
