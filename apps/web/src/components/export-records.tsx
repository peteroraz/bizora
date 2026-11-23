"use client";

import { Button, Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

/** Download every record of the business as spreadsheet files (pilot readiness, item 14). Owner and administrators. */
export function ExportRecords() {
  const t = useTranslations("settings.export");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      const response = await api("/api/v1/exports/business");
      if (response.status === 429) {
        setProblem(t("tooOften"));
        return;
      }
      if (!response.ok) {
        setProblem(t("failed"));
        return;
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "bizora-records.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // fetch fails only when the network does.
      setProblem(navigator.onLine ? t("failed") : t("offline"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3" data-testid="export-records">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="text-sm text-muted">{t("lead")}</p>
      <Button type="button" variant="secondary" onClick={() => void download()} disabled={busy} data-testid="export-download">
        {busy ? t("working") : t("download")}
      </Button>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
