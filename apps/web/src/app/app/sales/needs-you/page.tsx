"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, EmptyState, FormField, Input, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Problem = {
  id: string;
  errorMessage: string;
  soldAt: string | null;
  summary: string;
  totalMinor: string;
  createdAt: string;
};

/** Sales a phone could not sync. The owner records them, or says they were not sales (ADR-050). */
function NeedsYouScreen() {
  const t = useTranslations("sales");
  const locale = useLocale();
  const place = usePlace();
  const [items, setItems] = useState<Problem[] | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    const response = await api("/api/v1/sales/problems").catch(() => null);
    if (!response?.ok) {
      setItems([]);
      return;
    }
    setItems(((await response.json()).data.items ?? []) as Problem[]);
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, path: "record" | "dismiss") {
    setError(null);
    setPending(true);
    try {
      const response = await api(`/api/v1/sales/problems/${id}/${path}`, {
        method: "POST",
        body: JSON.stringify(path === "dismiss" ? { reason: reason.trim() } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? t("needsYou.failed"));
        return;
      }
      setReasonFor(null);
      setReason("");
      await load();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t("needsYou.title")} intro={t("needsYou.lead")} actions={<BackLink href="/app/sales">{t("allSales")}</BackLink>} />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {items && items.length === 0 ? <EmptyState title={t("needsYou.emptyTitle")} description={t("needsYou.emptyBody")} /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <Card className="space-y-3">
              <div>
                <p className="font-medium">{item.summary}</p>
                <p className="text-sm text-muted">
                  {formatWhen(item.soldAt ?? item.createdAt, locale, place.timezone)}
                  {" · "}
                  {formatCurrency(BigInt(item.totalMinor || "0"), place.currency, locale)}
                </p>
                <p className="mt-1 text-sm text-danger">{item.errorMessage}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={pending} onClick={() => void act(item.id, "record")}>
                  {t("needsYou.record")}
                </Button>
                <Button type="button" variant="outline" disabled={pending} onClick={() => setReasonFor(reasonFor === item.id ? null : item.id)}>
                  {t("needsYou.notASale")}
                </Button>
              </div>
              {reasonFor === item.id ? (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(item.id, "dismiss");
                  }}
                >
                  <FormField id="not-a-sale-reason" label={t("needsYou.reason")}>
                    <Input id="not-a-sale-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={240} />
                  </FormField>
                  <Button type="submit" variant="secondary" disabled={pending || reason.trim().length === 0}>
                    {t("needsYou.confirm")}
                  </Button>
                </form>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function NeedsYouPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_VOID]}>
      <NeedsYouScreen />
    </RequireAccess>
  );
}
