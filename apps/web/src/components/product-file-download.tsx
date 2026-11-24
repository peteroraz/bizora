"use client";

import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

/** Downloads every product as a CSV file the import reads back in (ADR-065). */
export function ProductFileDownload() {
  const t = useTranslations("imports");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      const response = await api("/api/v1/products/export.csv");
      if (!response.ok) return setProblem(t("downloadFailed"));
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "bizora-products.csv";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setProblem(t("downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button variant="secondary" disabled={busy} onClick={() => void download()} data-testid="download-products">
        {busy ? t("downloading") : t("downloadProducts")}
      </Button>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
