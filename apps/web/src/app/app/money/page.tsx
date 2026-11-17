"use client";

import { Permission } from "@bizora/contracts";
import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { RequireAccess } from "../../../components/require-access";
import { formatCurrency } from "../../../i18n/format";
import { can } from "../../../lib/access";
import { useAccess } from "../../../lib/access-context";
import { api } from "../../../lib/api";

/** Money: bank statements and matching today (ADR-020); cash position and money in and out come in Sprint 7. */
function MoneyScreen() {
  const t = useTranslations("money");
  const locale = useLocale();
  const access = useAccess();
  const reconciles = can(access, Permission.BANK_RECONCILE);
  const [counts, setCounts] = useState<{ currency: string; open: number; openMinor: string } | null>(null);

  useEffect(() => {
    if (!reconciles) return;
    void api("/api/v1/reconciliation/counts")
      .then(async (response) => (response.ok ? setCounts((await response.json()).data) : undefined))
      .catch(() => undefined);
  }, [reconciles]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} />
      <div className="grid gap-4 sm:grid-cols-2">
        {reconciles ? (
          <Card>
            <p className="text-sm font-medium">{t("bankTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("bankLead")}</p>
            {counts && counts.open > 0 ? (
              <p className="mt-2 text-sm">{t("toCheck", { count: counts.open, amount: formatCurrency(BigInt(counts.openMinor), counts.currency, locale) })}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-4 text-sm font-medium">
              <Link href="/app/money/bank" className="text-primary">
                {t("openInbox")}
              </Link>
              <Link href="/app/money/bank/upload" className="text-primary">
                {t("upload")}
              </Link>
            </div>
          </Card>
        ) : null}
        <Card>
          <p className="text-sm font-medium">{t("soonTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("soonBody")}</p>
        </Card>
      </div>
    </div>
  );
}

export default function MoneyPage() {
  return (
    <RequireAccess anyOf={[Permission.MONEY_READ, Permission.BANK_RECONCILE]}>
      <MoneyScreen />
    </RequireAccess>
  );
}
