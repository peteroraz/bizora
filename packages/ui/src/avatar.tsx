export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-9 w-9 items-center justify-center rounded-pill bg-sidebar-active text-sm font-medium text-sidebar-active-fg"
    >
      {initials || "?"}
    </span>
  );
}
