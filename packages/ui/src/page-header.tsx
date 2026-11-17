import type { ReactNode } from "react";

/**
 * A screen's title. `description` is information (a phone number, a date) and always shows;
 * `intro` is general help text, shown from tablet size up so phones keep their space for the work.
 */
export function PageHeader({
  title,
  description,
  intro,
  actions,
}: {
  title: string;
  description?: string;
  intro?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-7 sm:text-2xl sm:leading-8">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        {intro ? <p className="mt-1 hidden text-sm text-muted sm:block">{intro}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
