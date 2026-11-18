import type { ChangeEvent, FocusEvent, InputHTMLAttributes } from "react";
import { cn } from "./lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /**
   * Rewrites what is typed as it is typed: commas in amounts, capitals in names (ADR-027). The cursor stays after
   * the same character the person just typed, even when commas or spaces move around it.
   */
  format?: (text: string) => string;
  /** Rewrites the finished value when the box is left: "1,500.5" → "1,500.50", "  ada  okafor" → "Ada Okafor". */
  finish?: (text: string) => string;
};

/** Where the cursor goes after reformatting: the same count of letters and digits before it as before. */
function caretFor(before: string, caret: number, after: string) {
  if (before.length === after.length) return caret;
  const significant = before.slice(0, caret).replace(/[^\p{L}\p{N}.+]/gu, "").length;
  if (significant === 0) return 0;
  let seen = 0;
  for (let index = 0; index < after.length; index += 1) {
    if (/[\p{L}\p{N}.+]/u.test(after[index] ?? "")) seen += 1;
    if (seen === significant) return index + 1;
  }
  return after.length;
}

/** Puts a value into the box the way typing would, so a form's own onChange (controlled or not) sees it. */
function replaceValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Input({ className, format, finish, onChange, onBlur, ...props }: InputProps) {
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (format) {
      const typed = input.value;
      const next = format(typed);
      if (next !== typed) {
        const caret = caretFor(typed, input.selectionStart ?? typed.length, next);
        input.value = next;
        // Some boxes (email) cannot report or move the cursor.
        try {
          input.setSelectionRange(caret, caret);
        } catch {
          // Nothing to restore.
        }
      }
    }
    onChange?.(event);
  };
  const blur = (event: FocusEvent<HTMLInputElement>) => {
    if (finish) {
      const input = event.currentTarget;
      const next = finish(input.value);
      if (next !== input.value) replaceValue(input, next);
    }
    onBlur?.(event);
  };
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-control border border-border bg-input px-3 text-base text-fg md:text-sm outline-none placeholder:text-muted disabled:opacity-50 aria-[invalid=true]:border-danger-border",
        className,
      )}
      onChange={format || onChange ? change : undefined}
      onBlur={finish || onBlur ? blur : undefined}
      {...props}
    />
  );
}
