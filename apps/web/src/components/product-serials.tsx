"use client";

import { Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

/** A product's units in this shop that can be sold, by serial number or IMEI (ADR-062). */
export function ProductSerials({ productId, onHand }: { productId: string; onHand: string }) {
  const t = useTranslations("serials");
  const [items, setItems] = useState<{ id: string; serial: string; status: string }[] | null>(null);

  const load = useCallback(async () => {
    const response = await api(`/api/v1/products/${productId}/serials`).catch(() => null);
    if (response?.ok) setItems((await response.json()).data.items);
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load, onHand]);

  if (items === null) return null;
  const units = Number(BigInt(onHand) / 1000n);
  const without = units - items.length;
  return (
    <Card data-testid="product-serials">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{t("title", { count: items.length })}</p>
        <a href="/app/stock/serials" className="text-sm text-primary underline">
          {t("findLink")}
        </a>
      </div>
      {items.length === 0 ? <p className="mt-2 text-sm text-muted">{t("none")}</p> : null}
      {items.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2 text-sm">
          {items.map((item) => (
            <li key={item.id} className="rounded-control border border-border px-2 py-1 font-mono tabular-nums">
              {item.serial}
              {item.status === "returned" ? <span className="ml-1 text-xs text-muted">{t("returnedTag")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {without > 0 ? <p className="mt-2 text-xs text-muted">{t("without", { count: without })}</p> : null}
    </Card>
  );
}
