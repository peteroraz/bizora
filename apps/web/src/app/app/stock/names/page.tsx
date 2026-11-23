"use client";

import { Permission } from "@bizora/contracts";
import { Button, Card, PageHeader } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { api } from "../../../../lib/api";

type Row = { name: string; status: "new" | "exists" | "invalid" };
type Preview = { found: number; rows: Row[]; added: number };

/** Paste or upload names only. Prices, stock and barcodes can wait (ADR-049). */
function NameListScreen() {
  const t = useTranslations("stock");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(dryRun: boolean) {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api("/api/v1/saved-items/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, dryRun }),
      });
      const body = (await response.json().catch(() => null)) as { data?: Preview; message?: string } | null;
      if (!response.ok || !body?.data) {
        setError(body?.message ?? t("nameList.failed"));
        return;
      }
      setPreview(body.data);
      if (!dryRun) setMessage(t("nameList.added", { count: body.data.added }));
    } catch {
      setError(t("nameList.failed"));
    } finally {
      setPending(false);
    }
  }

  const fresh = preview?.rows.filter((row) => row.status === "new").length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title={t("nameList.title")} description={t("nameList.lead")} actions={<BackLink href="/app/stock">{t("title")}</BackLink>} />
      <Card className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="name-list">
          {t("names")}
        </label>
        <textarea
          id="name-list"
          className="min-h-40 w-full rounded-control border border-border bg-input px-3 py-2 text-sm"
          placeholder={t("nameList.placeholder")}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
          }}
        />
        <label className="inline-flex min-h-11 items-center text-sm text-primary">
          <input
            type="file"
            accept=".csv,.txt,text/plain,text/csv"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((contents) => {
                setText(contents);
                setPreview(null);
              });
            }}
          />
          {t("import")}
        </label>
        <Button type="button" className="min-h-11" disabled={pending || !text.trim()} onClick={() => void send(true)}>
          {t("nameList.review")}
        </Button>
      </Card>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-success">{message}</p> : null}
      {preview ? (
        <Card className="space-y-3">
          <ul className="divide-y divide-border text-sm">
            {preview.rows.map((row, index) => (
              <li key={`${row.name}-${index}`} className="flex min-h-11 items-center justify-between gap-3">
                <span>{row.name}</span>
                <span className="text-muted">{t(row.status === "new" ? "nameList.new" : row.status === "exists" ? "nameList.exists" : "nameList.invalid")}</span>
              </li>
            ))}
          </ul>
          <Button type="button" variant="primary" className="min-h-11" disabled={pending || fresh === 0} onClick={() => void send(false)}>
            {t("nameList.add", { count: fresh })}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

export default function NameListPage() {
  return (
    <RequireAccess anyOf={[Permission.CATALOG_MANAGE, Permission.PRODUCTS_MANAGE]}>
      <NameListScreen />
    </RequireAccess>
  );
}
