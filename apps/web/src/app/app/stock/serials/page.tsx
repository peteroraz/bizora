"use client";

import { Permission, normalizeSerial } from "@bizora/contracts";
import { Badge, Card, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { formatWhen } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Found = {
  id: string;
  serial: string;
  status: "in_stock" | "sold" | "returned" | "damaged" | "transferred" | "reserved";
  productId: string;
  productName: string;
  branchName: string;
  saleId: string | null;
  saleNumber: string | null;
  customerName?: string | null;
  history: { event: string; at: string; note: string | null; branchName: string | null; saleNumber: string | null }[];
};

const TONE = { in_stock: "success", returned: "info", sold: "neutral", damaged: "danger", transferred: "info", reserved: "warning" } as const;

/** Find a unit by its serial number or IMEI: where it is, who bought it, and what happened to it (ADR-062). */
function SerialsScreen() {
  const t = useTranslations("serials");
  const locale = useLocale();
  const { timezone } = usePlace();
  const [items, setItems] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader title={t("findTitle")} description={t("findLead")} actions={<BackLink href="/app/stock">{t("backToStock")}</BackLink>} />
      <SafeForm
        className="flex flex-wrap items-end gap-3"
        pending={pending}
        onSubmit={async (event) => {
          const q = normalizeSerial(String(new FormData(event.currentTarget).get("q") ?? ""));
          if (q.length < 3) return setError(t("tooShort"));
          setError(null);
          setPending(true);
          const response = await api(`/api/v1/stock/serials?q=${encodeURIComponent(q)}`).catch(() => null);
          setPending(false);
          const payload = response ? await response.json().catch(() => null) : null;
          if (!response?.ok) return setError(payload?.error?.message ?? t("failed"));
          setItems(payload.data.items);
        }}
      >
        <div className="min-w-0 flex-1">
          <FormField id="serial-q" label={t("findLabel")}>
            <Input id="serial-q" name="q" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={64} />
          </FormField>
        </div>
        <SubmitButton pending={pending} pendingLabel={t("finding")}>
          {t("find")}
        </SubmitButton>
      </SafeForm>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {items && items.length === 0 ? <p className="text-sm text-muted">{t("notFound")}</p> : null}
      {items?.map((item) => (
        <Card key={item.id} data-testid="serial-result">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-base font-semibold">{item.serial}</span>
            <Badge tone={TONE[item.status]}>{t(`status.${item.status}`)}</Badge>
          </div>
          <p className="mt-1 text-sm">
            <a href={`/app/stock/${item.productId}`} className="underline">
              {item.productName}
            </a>{" "}
            · {item.branchName}
          </p>
          {item.saleId ? (
            <p className="text-sm">
              <a href={`/app/sales/${item.saleId}`} className="underline">
                {t("soldOn", { number: item.saleNumber ?? "" })}
              </a>
              {item.customerName ? ` · ${item.customerName}` : ""}
            </p>
          ) : null}
          <ol className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted">
            {item.history.map((event, index) => (
              <li key={index}>
                {t.has(`events.${event.event}`) ? t(`events.${event.event}`) : event.event}
                {event.saleNumber ? ` · ${event.saleNumber}` : ""}
                {event.branchName ? ` · ${event.branchName}` : ""}
                {` · ${formatWhen(event.at, locale, timezone)}`}
                {event.note ? ` · ${event.note}` : ""}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

export default function SerialsPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <SerialsScreen />
    </RequireAccess>
  );
}
