"use client";

import { IDEMPOTENCY_HEADER, Permission, quantityToString, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { formatDay } from "../i18n/format";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
import { useStockText } from "./stock-quantity";

export type BatchView = {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  batchNumber: string | null;
  expiryDate: string | null;
  manufacturedDate: string | null;
  supplierName: string | null;
  quantity: string;
  daysLeft: number | null;
  status: "expired" | "soon" | "ok" | "none";
};

/** How a batch's expiry reads: "Expired 5 days ago", "12 days left", or the date. */
export function useExpiryText() {
  const t = useTranslations("batches");
  const locale = useLocale();
  return (batch: Pick<BatchView, "expiryDate" | "daysLeft" | "status">) => {
    if (!batch.expiryDate || batch.daysLeft === null) return t("noExpiry");
    const date = formatDay(batch.expiryDate, locale);
    if (batch.status === "expired") return t("expiredAgo", { date, days: -batch.daysLeft });
    if (batch.daysLeft === 0) return t("expiresToday", { date });
    return t("daysLeft", { date, days: batch.daysLeft });
  };
}

export function ExpiryBadge({ status }: { status: BatchView["status"] }) {
  const t = useTranslations("batches");
  if (status === "expired") return <Badge tone="danger">{t("expired")}</Badge>;
  if (status === "soon") return <Badge tone="warning">{t("soon")}</Badge>;
  return null;
}

/** A product's batches in this shop, earliest expiry first, with a way to take expired stock off (ADR-061). */
export function ProductBatches({
  productId,
  baseUnit,
  packs,
  onHand,
  onChanged,
}: {
  productId: string;
  baseUnit: string;
  packs: { unitCode: string; baseQuantity: string }[];
  /** The quantity on hand: the list is read again whenever it changes (stock in, a sale, a removal). */
  onHand: string;
  onChanged: () => void;
}) {
  const t = useTranslations("batches");
  const access = useAccess();
  const stockText = useStockText();
  const expiry = useExpiryText();
  const [items, setItems] = useState<BatchView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await api(`/api/v1/products/${productId}/batches`).catch(() => null);
    if (response?.ok) setItems((await response.json()).data.items);
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load, onHand]);

  async function takeOff(batch: BatchView) {
    setBusy(batch.id);
    setMessage(null);
    const response = await api("/api/v1/stock/adjust", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify({
        productId,
        direction: "remove",
        reason: "expired",
        quantity: quantityToString(BigInt(batch.quantity)),
        unit: baseUnit,
        batchId: batch.id,
        note: t("expiredNote", { batch: batch.batchNumber ?? t("noNumber") }),
      }),
    }).catch(() => null);
    setBusy(null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) return setMessage({ tone: "danger", text: payload?.error?.message ?? t("failed") });
    setMessage({ tone: "success", text: payload?.data?.waiting ? t("sentForApproval") : t("takenOff") });
    await load();
    onChanged();
  }

  if (items === null) return null;
  return (
    <Card data-testid="product-batches">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-sm text-muted">{t("lead")}</p>
      {message ? (
        <p className={`mt-2 text-sm ${message.tone === "success" ? "text-success" : "text-danger"}`} role="status">
          {message.text}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("none")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {items.map((batch) => (
            <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="batch-row">
              <span>
                <span className="block font-medium">{batch.batchNumber ?? t("noNumber")}</span>
                <span className="block text-muted">
                  {expiry(batch)}
                  {batch.supplierName ? ` · ${batch.supplierName}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{stockText(batch.quantity, baseUnit, packs)}</span>
                <ExpiryBadge status={batch.status} />
                {batch.status === "expired" && can(access, Permission.STOCK_ADJUST) ? (
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void takeOff(batch)}>
                    {busy === batch.id ? t("saving") : t("takeOff")}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
