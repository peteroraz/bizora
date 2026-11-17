import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-control text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:opacity-90",
        secondary: "border border-border bg-secondary text-secondary-fg hover:bg-sidebar",
        outline: "border border-border bg-transparent text-fg hover:bg-sidebar",
        ghost: "text-fg hover:bg-sidebar",
        danger: "bg-danger text-danger-bg hover:opacity-90",
      },
      size: {
        // Finger-sized: 44 px for the normal size, 40 px for compact rows (ADR-022).
        sm: "h-10 px-3 text-sm",
        md: "h-11 px-4",
        lg: "h-12 px-6 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref,
) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
