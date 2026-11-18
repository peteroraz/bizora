"use client";

import { Button, Card, FormField, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatCurrency } from "../i18n/format";
import { usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import { SentenceInput } from "./typing";

type Left = { productsInStock: number; belowZero: number; cashMinor: string; staff: number; customers: number; openSales: number };

/**
 * Close a shop (owners only, ADR-032). Shows what is still in it, then moves stock, cash, staff and customers into
 * another shop. History stays.
 */
export function CloseShop({ shop, otherShops, onClosed }: { shop: { id: string; name: string }; otherShops: { id: string; name: string }[]; onClosed: (text: string) => void }) {
  const t = useTranslations("settings.closeShop");
  const locale = useLocale();
  const place = usePlace();
  const [left, setLeft] = useState<Left | null>(null);
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState(otherShops[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setError(null);
    const response = await api(`/api/v1/branches/${shop.id}/closing`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) return setError(payload?.error?.message ?? t("failed"));
    setLeft(payload.data as Left);
  }

  async function close() {
    setPending(true);
    setError(null);
    const response = await api(`/api/v1/branches/${shop.id}/close`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim(), ...(moveTo ? { moveToBranchId: moveTo } : {}) }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (!response?.ok) return setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
    const target = otherShops.find((item) => item.id === moveTo);
    onClosed(target ? t("closedMoved", { shop: shop.name, target: target.name }) : t("closed", { shop: shop.name }));
  }

  if (otherShops.length === 0) return <p className="text-sm text-muted">{t("onlyShop")}</p>;
  if (!left) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="secondary" className="text-danger" onClick={() => void open()} data-testid={`close-shop-${shop.id}`}>
          {t("open", { shop: shop.name })}
        </Button>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const cash = BigInt(left.cashMinor);
  const blocked = left.openSales > 0 || left.belowZero > 0;
  return (
    <Card className="border-danger">
      <SafeForm className="space-y-4" pending={pending} onSubmit={close}>
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t("title", { shop: shop.name })}</p>
          <p className="text-muted">{t("lead")}</p>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="close-shop-left">
          <li>{t("leftStock", { count: left.productsInStock })}</li>
          <li>{t("leftCash", { amount: formatCurrency(cash < 0n ? -cash : cash, place.currency, locale) })}</li>
          <li>{t("leftStaff", { count: left.staff })}</li>
          <li>{t("leftCustomers", { count: left.customers })}</li>
        </ul>
        {left.openSales > 0 ? <p className="text-sm text-danger">{t("openSales", { count: left.openSales })}</p> : null}
        {left.belowZero > 0 ? <p className="text-sm text-danger">{t("belowZero", { count: left.belowZero })}</p> : null}
        <FormField id={`close-move-${shop.id}`} label={t("moveTo")} hint={t("moveToHint")}>
          <Select id={`close-move-${shop.id}`} value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
            {otherShops.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id={`close-reason-${shop.id}`} label={t("reason")} hint={t("reasonHint")}>
          <SentenceInput id={`close-reason-${shop.id}`} value={reason} required minLength={3} maxLength={240} onChange={(event) => setReason(event.target.value)} />
        </FormField>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending} pendingLabel={t("closing")} variant="danger" disabled={blocked}>
            {t("confirm", { shop: shop.name })}
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={() => setLeft(null)}>
            {t("cancel")}
          </Button>
        </div>
      </SafeForm>
    </Card>
  );
}
