"use client";

import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

/**
 * Sends a PDF from the API through the phone's share menu (WhatsApp). Where files cannot be shared, the PDF is saved
 * and a WhatsApp link with a download link is offered instead (ADR-017).
 */
export function SendPdf({ url, label, whatsAppHref, variant = "secondary" }: { url: string; label: string; whatsAppHref?: string; variant?: "primary" | "secondary" }) {
  const t = useTranslations("sales");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function send() {
    setNotice(null);
    setBusy(true);
    try {
      const response = await api(url);
      if (!response.ok) throw new Error("failed");
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "document.pdf";
      const file = new File([blob], name, { type: "application/pdf" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      setNotice(t("docSaved", { name }));
    } catch {
      setNotice(t("docFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" size="sm" variant={variant} disabled={busy} onClick={() => void send()}>
        {busy ? t("docPreparing") : label}
      </Button>
      {notice ? (
        <span className="text-xs text-muted" role="status">
          {notice}{" "}
          {whatsAppHref ? (
            <a className="text-primary" href={whatsAppHref} target="_blank" rel="noreferrer">
              {t("docWhatsAppLink")}
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
