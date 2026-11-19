"use client";

import { Badge, Button, Card, FormField, Input } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { formatWhen } from "../i18n/format";
import { usePlace } from "../lib/access-context";
import { api } from "../lib/api";

type Request = {
  id: string;
  kind: "receive" | "adjust" | "transfer" | "supplier_return";
  status: "pending" | "approved" | "rejected";
  summary: string;
  shop: string | null;
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decisionNote: string | null;
};
type List = { canApprove: boolean; waiting: Request[]; decided: Request[] };

/**
 * Store keeper's stock in, changes, moves and returns that wait for a manager or owner (ADR-034). Approvers complete
 * or turn them down here; the store keeper sees what is waiting and what was decided.
 */
export function StockRequests({ onDecided }: { onDecided?: () => void }) {
  const t = useTranslations("stockRequests");
  const locale = useLocale();
  const { timezone } = usePlace();
  const [list, setList] = useState<List | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api("/api/v1/stock/requests").catch(() => null);
    if (response?.ok) setList((await response.json()).data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: Request, action: "approve" | "reject") {
    const note = notes[item.id]?.trim() ?? "";
    if (action === "reject" && note.length < 3) {
      setErrors((current) => ({ ...current, [item.id]: t("sayWhy") }));
      return;
    }
    setBusy(item.id);
    setErrors((current) => ({ ...current, [item.id]: "" }));
    const response = await api(`/api/v1/stock/requests/${item.id}/${action}`, { method: "POST", body: JSON.stringify(note ? { note } : {}) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(null);
    if (!response?.ok) {
      setErrors((current) => ({ ...current, [item.id]: payload?.error?.message ?? t("failed") }));
      return;
    }
    await load();
    onDecided?.();
  }

  if (!list || (list.waiting.length === 0 && (list.canApprove || list.decided.length === 0))) return null;
  return (
    <Card className="space-y-3" data-testid="stock-requests">
      <p className="text-sm font-medium">{list.canApprove ? t("approveTitle", { count: list.waiting.length }) : t("mineTitle")}</p>
      {list.waiting.length > 0 ? (
        <ul className="space-y-3 text-sm">
          {list.waiting.map((item) => (
            <li key={item.id} className="space-y-2 rounded-md border border-border p-3" data-testid="stock-request">
              <p className="font-medium">{item.summary}</p>
              <p className="text-muted">{t("askedBy", { name: item.requestedBy ?? "", shop: item.shop ?? "", when: formatWhen(item.requestedAt, locale, timezone) })}</p>
              {list.canApprove ? (
                <>
                  <FormField id={`request-note-${item.id}`} label={t("note")} hint={t("noteHint")} error={errors[item.id] || undefined}>
                    <Input id={`request-note-${item.id}`} maxLength={240} value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} />
                  </FormField>
                  <div className="flex flex-wrap gap-3">
                    <Button size="sm" disabled={busy === item.id} onClick={() => void decide(item, "approve")}>
                      {t("approve")}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy === item.id} onClick={() => void decide(item, "reject")}>
                      {t("reject")}
                    </Button>
                  </div>
                </>
              ) : (
                <Badge tone="warning">{t("waiting")}</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!list.canApprove && list.decided.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {list.decided.slice(0, 5).map((item) => (
            <li key={item.id}>
              <Badge tone={item.status === "approved" ? "success" : "danger"}>{t(item.status)}</Badge> {item.summary}
              {item.decisionNote ? <span className="text-muted"> · {t("decisionLine", { name: item.decidedBy ?? "", note: item.decisionNote })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
