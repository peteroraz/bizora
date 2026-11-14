"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export function DropdownMenu({
  trigger,
  label,
  children,
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          aria-label={label}
          align="end"
          sideOffset={8}
          className="z-40 min-w-56 rounded-overlay border border-border bg-card p-1 text-fg shadow-lg"
        >
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function DropdownItem({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect?: () => void;
}) {
  return (
    <Dropdown.Item
      className="cursor-pointer rounded-control px-3 py-2 text-sm outline-none data-[highlighted]:bg-sidebar-active data-[highlighted]:text-sidebar-active-fg"
      onSelect={onSelect}
    >
      {children}
    </Dropdown.Item>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-xs font-medium text-muted">{children}</div>;
}
