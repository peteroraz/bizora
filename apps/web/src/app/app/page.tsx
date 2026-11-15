"use client";

import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Permission } from "@bizora/contracts";
import { can, homeCards } from "../../lib/access";
import { useAccess } from "../../lib/access-context";
import { api } from "../../lib/api";
import { formatCurrency, formatWhen } from "../../i18n/format";

type Check = { id: string; done: boolean; href: string };
type Followup = { id: string; customerId: string; customerName: string; reason: string; dueAt: string };

export default function AppHomePage() {
  const t = useTranslations("home");
  const locale = useLocale();
  const access = useAccess();
  const shown = homeCards(access);
  const seesCustomers = can(access, Permission.CUSTOMERS_READ);
  const ownFollowupsOnly = !can(access, Permission.FOLLOWUPS_READ_ALL);
  const [name, setName] = useState("");
  const [checks, setChecks] = useState<Check[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [currency, setCurrency] = useState("NGN");

  useEffect(() => {
    void (async () => {
      const meResponse = await api("/api/v1/auth/me");
      if (!meResponse.ok) return;
      const me = await meResponse.json();
      if (me.data?.onboardingCompleted === false) {
        window.location.href = "/app/onboarding";
        return;
      }
      setName(me.data?.user?.displayName ?? "");
      const dashboard = await api("/api/v1/dashboard");
      if (!dashboard.ok) return;
      const payload = await dashboard.json();
      setChecks(payload.data?.checklist ?? []);
      setFollowups(payload.data?.followupsDueToday ?? []);
      setOverdue(payload.data?.overdueCount ?? 0);
      setCustomerCount(payload.data?.customerCount ?? 0);
      setTimezone(payload.data?.timezone ?? "Africa/Lagos");
      setCurrency(payload.data?.currency ?? "NGN");
    })();
  }, []);

  const figureCards = (
    [
      ["sales", t("sales"), t("emptySales")],
      ["mySales", t("mySales"), t("emptySales")],
      ["money", t("money"), t("emptyMoney")],
      ["cash", t("cash"), t("emptyCash")],
      ["debtors", t("debtors"), t("emptyDebtors")],
      ["stock", t("stock"), t("emptyStock")],
      ["staff", t("staff"), t("emptyStaff")],
      ["approval", t("approval"), t("emptyApproval")],
    ] as const
  ).filter(([id]) => shown.includes(id));
  const today = t("today", { date: formatWhen(new Date(), locale, timezone) });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("welcome", { name: name || t("fallbackName") })}
        description={seesCustomers ? `${t("customerCount", { count: customerCount })} · ${today}` : today}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {figureCards.map(([id, title, empty]) => (
          <Card key={id}>
            <p className="text-sm text-muted">{title}</p>
            <p className="mt-2 text-sm">{empty}</p>
            {id === "money" ? <p className="mt-2 text-xs text-muted">{t("moneyHint", { amount: formatCurrency(0n, currency, locale) })}</p> : null}
          </Card>
        ))}
        {shown.includes("findCustomer") ? (
          <Card>
            <p className="text-sm text-muted">{t("findCustomer")}</p>
            <p className="mt-2 text-sm">{t("findCustomerBody")}</p>
            <Link href="/app/customers" className="mt-3 inline-block text-sm font-medium text-primary">
              {t("findCustomerAction")}
            </Link>
          </Card>
        ) : null}
        {shown.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">{t("nothingYet")}</p>
            <p className="mt-2 text-sm">{t("nothingYetBody")}</p>
          </Card>
        ) : null}
        {shown.includes("followups") ? (
          <Card>
            <p className="text-sm text-muted">{ownFollowupsOnly ? t("myFollowups") : t("followups")}</p>
            {followups.length === 0 ? <p className="mt-2 text-sm">{t("noFollowups")}</p> : null}
            <ul className="mt-3 space-y-2 text-sm">
              {followups.map((item) => (
                <li key={item.id}>
                  <Link href={`/app/customers/${item.customerId}`} className="font-medium text-primary">
                    {item.customerName}
                  </Link>
                  <span className="mt-0.5 block text-muted">
                    {item.reason} · {formatWhen(item.dueAt, locale, timezone)}
                  </span>
                </li>
              ))}
            </ul>
            {overdue > 0 ? <p className="mt-3 text-sm text-warning">{t("overdue", { count: overdue })}</p> : null}
            <Link href="/app/customers/follow-ups" className="mt-3 inline-block text-sm font-medium text-primary">
              {t("seeFollowups")}
            </Link>
          </Card>
        ) : null}
      </div>
      {checks.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("setup")}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {checks.map((check) => (
              <li key={check.id}>
                <Link href={check.href} className="flex items-center justify-between gap-3">
                  <span>{t(`checklist.${check.id}`)}</span>
                  <span className={check.done ? "text-success" : "text-muted"}>{check.done ? t("done") : t("todo")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
