"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export function Tab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted data-[state=active]:border-primary data-[state=active]:text-fg"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Content value={value} className="pt-4">
      {children}
    </TabsPrimitive.Content>
  );
}

export function TabsRoot({
  value,
  onValueChange,
  label,
  tabs,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  tabs: ReactNode;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  );
}
