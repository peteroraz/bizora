"use client";

import { useState, type ComponentType, type ReactNode } from "react";

type SheetProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  trigger?: ReactNode;
  children: ReactNode;
};

/**
 * A slide-in menu whose code loads the first time it is opened, so it does not count against the JavaScript budget
 * of every screen (Spec §8). Until then only the trigger button is on the page.
 */
export function LazySheet(props: SheetProps) {
  const [Sheet, setSheet] = useState<ComponentType<SheetProps> | null>(null);
  if (Sheet) return <Sheet {...props} />;
  return (
    <span
      className="contents"
      onClickCapture={(event) => {
        event.preventDefault();
        void import("@bizora/ui/sheet").then((module) => {
          setSheet(() => module.Sheet);
          props.onOpenChange?.(true);
        });
      }}
    >
      {props.trigger}
    </span>
  );
}
