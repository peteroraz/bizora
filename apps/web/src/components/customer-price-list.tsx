"use client";

import { Card, FormField } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { problemOf } from "../lib/money-client";

/** The price list a customer buys at, such as wholesale (ADR-048). Managers set it; the sale screen uses it. */
export function CustomerPriceList({ customerId, priceListId }: { customerId: string; priceListId: string | null }) {
  const t = useTranslations("pricing.customer");
  const [lists, setLists] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [value, setValue] = useState(priceListId ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("/api/v1/pricing/lists")
      .then(async (response) => (response.ok ? ((await response.json()) as { data: { lists: { id: string; name: string; active: boolean }[] } }).data.lists : []))
      .then(setLists)
      .catch(() => undefined);
  }, []);

  async function choose(next: string) {
    setValue(next);
    setNotice(null);
    setError(null);
    const response = await api(`/api/v1/customers/${customerId}/price-list`, { method: "PUT", body: JSON.stringify({ priceListId: next || null }) }).catch(() => null);
    if (!response?.ok) {
      setValue(priceListId ?? "");
      setError(response ? await problemOf(response, t("failed")) : t("failed"));
      return;
    }
    setNotice(next ? t("saved", { name: lists.find((list) => list.id === next)?.name ?? "" }) : t("cleared"));
  }

  if (lists.length === 0) return null;
  return (
    <Card>
      <FormField id="customer-price-list" label={t("label")} hint={t("hint")}>
        <select id="customer-price-list" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={value} onChange={(event) => void choose(event.target.value)}>
          <option value="">{t("everyday")}</option>
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.active ? list.name : t("off", { name: list.name })}
            </option>
          ))}
        </select>
      </FormField>
      {notice ? (
        <p className="mt-2 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
