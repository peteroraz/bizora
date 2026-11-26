"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

/**
 * Bizora has suspended this business (ADR-071). The owner sees why, in a word, above every screen, and can still read
 * and download. Staff see only this: the server refuses everything else, and their saved work waits on the phone.
 * Loaded only for a suspended business, so it adds nothing to anyone else's screens.
 */
export default function SuspendedNotice({ owner, reasonCode }: { owner: boolean; reasonCode: string | null }) {
  const t = useTranslations("suspended");
  const reason = reasonCode && t.has(`reason.${reasonCode}`) ? t(`reason.${reasonCode}`) : t("reason.other");
  if (owner) {
    return (
      <div className="border-b border-danger bg-danger/10 px-4 py-3 text-sm text-danger md:px-8" role="alert" data-testid="suspended-notice">
        <p className="font-semibold">{t("ownerTitle")}</p>
        <p>{t("ownerBody", { reason })}</p>
        <Link href="/app/settings" className="inline-flex min-h-11 items-center font-medium underline">
          {t("download")}
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-lg space-y-3 px-4 py-10 text-center" role="alert" data-testid="suspended-notice">
      <h1 className="text-xl font-semibold">{t("staffTitle")}</h1>
      <p className="text-muted">{t("staffBody")}</p>
    </div>
  );
}
