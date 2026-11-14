import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "./lib/cn";

const badgeVariants = cva("inline-flex items-center rounded-pill border px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "border-border bg-secondary text-secondary-fg",
      success: "border-success bg-success-bg text-success",
      warning: "border-warning bg-warning-bg text-warning",
      danger: "border-danger bg-danger-bg text-danger",
      info: "border-info bg-info-bg text-info",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
