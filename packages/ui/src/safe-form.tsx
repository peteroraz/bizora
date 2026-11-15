"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";

export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

export function SafeForm({
  className,
  pending = false,
  onSubmit,
  children,
}: {
  className?: string;
  pending?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> | void;
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  const lock = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending || lock.current) return;
    lock.current = true;
    try {
      await onSubmit(event);
    } finally {
      lock.current = false;
    }
  }

  return (
    <form className={className} data-hydrated={hydrated ? "true" : "false"} onSubmit={(event) => void handleSubmit(event)}>
      {children}
    </form>
  );
}

export function SubmitButton({
  pending = false,
  pendingLabel,
  children,
  disabled,
  ...props
}: ButtonProps & { pending?: boolean; pendingLabel: string }) {
  const hydrated = useHydrated();
  const locked = !hydrated || pending || Boolean(disabled);
  return (
    <Button {...props} type="submit" disabled={locked} aria-disabled={locked} aria-busy={pending || undefined}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
