import { getTranslations } from "next-intl/server";

export type WorkStatus = {
  owner: boolean;
  open: boolean;
  today: { open: string; close: string } | null;
  locked: { shop: string; note: string | null } | null;
  permitUntil: string | null;
  blocked: { code: "SHOP_LOCKED" | "OUTSIDE_HOURS"; message: string } | null;
};

/**
 * Tells staff, at the top of every screen, when their shop is locked or the business is closed (ADR-034). Rendered on
 * the server, so it adds no JavaScript to any screen. The API refuses changes either way; this says why in advance.
 */
export async function WorkBanner({ status, timeZone }: { status: WorkStatus | null; timeZone: string }) {
  if (!status || status.owner) return null;
  const t = await getTranslations("workRules.banner");
  const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  if (status.locked) {
    return (
      <p className="border-b border-danger bg-danger/10 px-4 py-2 text-sm text-danger md:px-8" role="status" data-testid="work-banner">
        {status.locked.note ? t("lockedWithNote", { shop: status.locked.shop, note: status.locked.note }) : t("locked", { shop: status.locked.shop })}
      </p>
    );
  }
  if (status.permitUntil && !status.open) {
    return (
      <p className="border-b border-warning bg-warning-bg px-4 py-2 text-sm text-warning md:px-8" role="status" data-testid="work-banner">
        {t("permitted", { until: time(status.permitUntil) })}
      </p>
    );
  }
  if (status.blocked?.code === "OUTSIDE_HOURS") {
    return (
      <p className="border-b border-warning bg-warning-bg px-4 py-2 text-sm text-warning md:px-8" role="status" data-testid="work-banner">
        {status.today ? t("closedNow", { open: status.today.open, close: status.today.close }) : t("closedToday")}
      </p>
    );
  }
  return null;
}
