"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "./input";

export type ComboboxItem = { value: string; label: string };

export function Combobox({
  id,
  label,
  items,
  value,
  onValueChange,
  placeholder = "Search",
  describedBy,
}: {
  id?: string;
  label: string;
  items: ComboboxItem[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = items.find((item) => item.value === value);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? items.filter(
          (item) => item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle),
        )
      : items;
    return matches.slice(0, 50);
  }, [items, query]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function choose(next: string) {
    onValueChange(next);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={inputId}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? `${inputId}-option-${filtered[active].value}` : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? "")}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter" && open) {
            const selectedItem = filtered[active];
            if (!selectedItem) return;
            event.preventDefault();
            choose(selectedItem.value);
          } else if (event.key === "Escape") {
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-control border border-border bg-card p-1 shadow-md"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No matches</li>
          ) : (
            filtered.map((item, index) => (
              <li
                key={item.value}
                id={`${inputId}-option-${item.value}`}
                role="option"
                aria-selected={item.value === value}
                className={`cursor-pointer rounded-control px-3 py-2 text-sm ${index === active ? "bg-sidebar-active text-sidebar-active-fg" : "text-fg"}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item.value);
                }}
              >
                {item.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
