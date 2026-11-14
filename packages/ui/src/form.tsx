import * as LabelPrimitive from "@radix-ui/react-label";
import type { LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "./lib/cn";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <LabelPrimitive.Root className={cn("text-sm font-medium text-fg", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-control border border-border bg-input px-3 py-2 text-sm text-fg outline-none placeholder:text-muted disabled:opacity-50 aria-[invalid=true]:border-danger-border",
        className,
      )}
      {...props}
    />
  );
}

export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs font-medium text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
