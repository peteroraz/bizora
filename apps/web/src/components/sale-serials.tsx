"use client";

import { IDEMPOTENCY_HEADER, Permission, splitSerials, uuidv7 } from "@bizora/contracts";
import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
import type { SaleDetail, SaleLineView } from "../lib/sales-client";

/**
 * The serial numbers or IMEIs on a sale line (ADR-062), and a box to add the ones not recorded yet. Scanned or
 * typed one per line; a serial already sold is refused with the sale it went on.
 */
export function SaleLineSerials({ saleId, line, open, onSaved }: { saleId: string; line: SaleLineView; open: boolean; onSaved: (sale: SaleDetail) => void }) {
  const t = useTranslations("serials");
  const access = useAccess();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serials = line.serials ?? [];
  const units = BigInt(line.quantity) / 1000n;
  const missing = Number(units) - serials.length;
  const mayAdd = open && missing > 0 && can(access, Permission.SALES_CREATE, Permission.SALES_RELEASE, Permission.SALES_VOID);
  if (!line.keepsSerials) return null;

  async function save() {
    const list = splitSerials(text);
    if (list.length === 0) return setError(t("enterOne"));
    if (list.length > missing) return setError(t("tooMany", { count: missing }));
    setBusy(true);
    setError(null);
    const response = await api(`/api/v1/sales/${saleId}/serials`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify({ lines: [{ saleLineId: line.id, serials: list }] }),
    }).catch(() => null);
    setBusy(false);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) return setError(payload?.error?.message ?? t("failed"));
    setText("");
    onSaved(payload.data.sale);
  }

  return (
    <span className="mt-1 block text-xs" data-testid="line-serials">
      {serials.length > 0 ? <span className="block text-muted">{t("onLine", { serials: serials.join(", ") })}</span> : null}
      {mayAdd ? (
        <span className="mt-1 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="block text-muted">{t("add", { count: missing })}</span>
            <textarea
              className="mt-1 block min-h-11 w-full rounded-control border border-border bg-input px-3 py-2 text-base md:text-sm"
              rows={Math.min(missing, 3)}
              value={text}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <Button variant="secondary" disabled={busy} onClick={() => void save()}>
            {busy ? t("saving") : t("save")}
          </Button>
        </span>
      ) : null}
      {error ? (
        <span className="mt-1 block text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
