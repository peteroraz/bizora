"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Copies text, falling back to a hidden text box where the clipboard is blocked (older phones, plain http). */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the text box.
  }
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  box.remove();
  return done;
}

/**
 * A button that copies text as often as it is pressed (7f). It says "Copied" for a moment, then goes back, so it never
 * looks used up.
 */
export function CopyButton({ text, label, copiedLabel, failedLabel, className, ...rest }: { text: () => string; label: ReactNode; copiedLabel: ReactNode; failedLabel: ReactNode; className?: string; "data-testid"?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className={className}
      data-testid={rest["data-testid"]}
      onClick={() => {
        void copyText(text()).then((ok) => {
          setState(ok ? "copied" : "failed");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState("idle"), 2000);
        });
      }}
    >
      <span aria-live="polite">{state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label}</span>
    </button>
  );
}
