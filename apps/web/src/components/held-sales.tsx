"use client";

import { Button, Card, FormField, Input } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatCurrency } from "../i18n/format";
import { HELD_OLD_MS, type HeldSale } from "../lib/offline/held-sales";

/**
 * Hold a sale, or pick one back up (ADR-070). Loaded only when the cashier taps Hold or Held sales, so the quick
 * sale's first download stays within its budget.
 */
export default function HeldPanel(props: {
  mode: "hold" | "list";
  items: HeldSale[];
  suggestedName: string;
  cartEmpty: boolean;
  onHold: (name: string) => void;
  onResume: (sale: HeldSale) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { mode, items, suggestedName, cartEmpty, onHold, onResume, onDelete, onClose } = props;
  const t = useTranslations("held");
  const locale = useLocale();
  const [name, setName] = useState(suggestedName);
  const [now] = useState(() => Date.now());
  // Delete asks once more on the same button, so a stray tap does not lose a customer's cart.
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "hold") document.getElementById("held-name")?.focus();
  }, [mode]);
  const when = (iso: string) => {
    const at = new Date(iso);
    const old = now - at.getTime() >= HELD_OLD_MS;
    return new Intl.DateTimeFormat(locale, old ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" }).format(at);
  };

  if (mode === "hold") {
    return (
      <Card data-testid="hold-panel">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onHold(name.trim() || t("unnamed"));
          }}
        >
          <h2 className="text-base font-semibold">{t("holdTitle")}</h2>
          <p className="text-sm text-muted">{t("holdLead")}</p>
          <FormField id="held-name" label={t("name")} hint={t("nameHint")}>
            <Input id="held-name" maxLength={60} autoCapitalize="sentences" value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{t("hold")}</Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card data-testid="held-list">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("listTitle")}</h2>
          <p className="text-sm text-muted">{cartEmpty ? t("listLead") : t("finishFirst")}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("close")}
        </Button>
      </div>
      {items.length === 0 ? <p className="mt-3 text-sm text-muted">{t("none")}</p> : null}
      <ul className="mt-3 divide-y divide-border">
        {items.map((sale) => (
          <li key={sale.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="held-sale">
            <div className="min-w-0">
              <p className="font-medium">{sale.name}</p>
              <p className="text-sm text-muted">
                {t("summary", { count: sale.lines.length, total: formatCurrency(BigInt(sale.totalMinor), sale.currency, locale), time: when(sale.heldAt) })}
                {sale.customer ? ` · ${sale.customer.name}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={!cartEmpty} onClick={() => onResume(sale)}>
                {t("resume")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={confirming === sale.id ? "danger" : "outline"}
                onClick={() => {
                  if (confirming === sale.id) onDelete(sale.id);
                  else setConfirming(sale.id);
                }}
              >
                {confirming === sale.id ? t("deleteConfirm") : t("delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
