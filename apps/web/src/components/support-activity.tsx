"use client";

import { Card } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Item = { id: string; at: string; staffEmail: string; action: string; reason: string | null; page: string | null };

/** What Bizora staff looked at or did in this business, with who and why (ADR-039, Terms of use section 5). */
export function SupportActivity() {
  const t = useTranslations("supportActivity");
  const locale = useLocale();
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    void api("/api/v1/support-activity")
      .then(async (response) => setItems(response.ok ? ((await response.json()).data.items as Item[]) : []))
      .catch(() => setItems([]));
  }, []);

  const when = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const what = (item: Item) => {
    const key = `actions.${item.action.replaceAll(".", "_")}`;
    const base = t.has(key) ? t(key) : t("actions.other");
    return item.page && t.has(`pages.${item.page}`) ? `${base}: ${t(`pages.${item.page}`)}` : base;
  };

  return (
    <Card className="space-y-3" data-testid="support-activity">
      <p className="text-sm text-muted">
        {t("lead")}{" "}
        <a href="/terms#bizora-access" target="_blank" rel="noopener" className="text-primary underline underline-offset-2">
          {t("terms")}
        </a>
      </p>
      {items === null ? null : items.length === 0 ? (
        <p className="text-sm">{t("none")}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {items.map((item) => (
            <li key={item.id} className="space-y-0.5 py-2">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{what(item)}</span>
                <span className="text-muted tabular-nums">{when(item.at)}</span>
              </div>
              <p className="text-muted">
                {item.staffEmail}
                {item.reason ? ` · ${item.reason}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
