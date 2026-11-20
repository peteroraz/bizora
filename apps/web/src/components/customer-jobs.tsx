"use client";

import { Permission } from "@bizora/contracts";
import { Badge, Card } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCurrency, formatDay } from "../i18n/format";
import { can } from "../lib/access";
import { useAccess, usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import type { JobListItem } from "../lib/jobs-client";

const tone = { open: "warning", done: "success", cancelled: "neutral" } as const;

/** What has been done for this customer, what is going on now, and a new job for them (ADR-035). */
export function CustomerJobs({ customerId, customerName }: { customerId: string; customerName: string }) {
  const t = useTranslations("jobs");
  const locale = useLocale();
  const access = useAccess();
  const { currency } = usePlace();
  const [items, setItems] = useState<JobListItem[] | null>(null);
  const allowed = can(access, Permission.SALES_CREATE, Permission.SALES_READ_ALL, Permission.SALES_READ_OWN);
  useEffect(() => {
    if (!allowed) return;
    void api(`/api/v1/jobs?customerId=${customerId}`)
      .then(async (response) => setItems(response.ok ? ((await response.json()).data.items as JobListItem[]) : []))
      .catch(() => setItems([]));
  }, [customerId, allowed]);
  if (!allowed || items === null || (items.length === 0 && !can(access, Permission.SALES_CREATE))) return null;
  return (
    <Card className="space-y-3" data-testid="customer-jobs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("customerJobs")}</p>
        {can(access, Permission.SALES_CREATE) ? (
          <Link className="text-sm font-medium text-primary" href={`/app/jobs/new?customerId=${customerId}&customerName=${encodeURIComponent(customerName)}`}>
            {t("newForCustomer")}
          </Link>
        ) : null}
      </div>
      {items.length === 0 ? <p className="text-sm text-muted">{t("noneForCustomer")}</p> : null}
      <ul className="divide-y divide-border text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2 py-2">
            <Link href={`/app/jobs/${item.id}`} className="text-primary">
              {item.number} · {formatDay(item.openedOn, locale)}
              {item.title ? ` · ${item.title}` : ""}
            </Link>
            <span className="flex items-center gap-2">
              {BigInt(item.leftMinor) > 0n ? <span>{t("leftShort", { amount: formatCurrency(BigInt(item.leftMinor), currency, locale) })}</span> : null}
              <Badge tone={tone[item.status]}>{t(`status.${item.status}`)}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
