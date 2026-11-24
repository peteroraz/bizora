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
  actionsLayout = "wrap",
}: {
  title: string;
  description?: string;
  intro?: string;
  actions?: ReactNode;
  /** "scroll": on phones the actions stay on one line that scrolls sideways, with the main action first, so the page's content is not pushed down. */
  actionsLayout?: "wrap" | "scroll";
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-7 sm:text-2xl sm:leading-8">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        {intro ? <p className="mt-1 hidden text-sm text-muted sm:block">{intro}</p> : null}
      </div>
      {actions ? (
        <div
          className={
            actionsLayout === "scroll"
              ? "-mx-4 flex basis-full items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:basis-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0 [&>.bg-primary]:-order-1 sm:[&>.bg-primary]:order-none"
              : "flex flex-wrap items-center gap-2"
          }
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
