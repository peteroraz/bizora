"use client";

import type { SavedItem } from "@bizora/contracts";
import { Button } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatCurrency } from "../i18n/format";
import { usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import { useUnitName } from "./stock-quantity";

/** Items typed in at sales and remembered (ADR-041). The owner can remove a misspelt or old one. */
export function SavedItemsList() {
  const t = useTranslations("settings.savedItems");
  const locale = useLocale();
  const place = usePlace();
  const unitName = useUnitName();
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    const response = await api("/api/v1/saved-items").catch(() => null);
    if (!response?.ok) return setProblem(t("loadFailed"));
    setItems(((await response.json()) as { data: { items: SavedItem[] } }).data.items);
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(item: SavedItem) {
    setProblem(null);
    const response = await api(`/api/v1/saved-items/${item.id}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) return setProblem(t("removeFailed", { name: item.name }));
    setItems((current) => current?.filter((known) => known.id !== item.id) ?? null);
  }

  return (
    <div className="space-y-2 rounded-card border border-border p-3" data-testid="saved-items">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted">{t("lead")}</p>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      {items === null ? null : items.length === 0 ? (
        <p className="text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <span className="block font-medium">{item.name}</span>
                <span className="block text-xs text-muted">
                  {t("detail", {
                    price: item.lastPriceMinor ? formatCurrency(BigInt(item.lastPriceMinor), place.currency ?? "NGN", locale) : t("noPrice"),
                    unit: unitName(item.unit, 1),
                    count: item.timesSold,
                  })}
                </span>
              </span>
              <Button variant="secondary" onClick={() => void remove(item)} aria-label={t("removeNamed", { name: item.name })}>
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
