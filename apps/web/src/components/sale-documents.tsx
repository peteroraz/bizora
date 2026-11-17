"use client";

import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

type DocType = "invoice" | "receipt";

/**
 * Sends a sale's invoice or receipt PDF (ADR-017). On phones the share menu opens with the PDF attached, so staff
 * pick WhatsApp and the customer. Where a browser cannot share files, the PDF is saved instead and WhatsApp opens
 * with a link the customer can use to download it.
 */
export function SaleDocuments({
  saleId,
  documents,
  credit,
  receiptPath,
  whatsAppPrefix,
  whatsAppText,
}: {
  saleId: string;
  documents: DocType[];
  credit: boolean;
  receiptPath: string;
  whatsAppPrefix: string;
  whatsAppText: string;
}) {
  const t = useTranslations("sales");
  const [busy, setBusy] = useState<DocType | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const label = (type: DocType) => (type === "receipt" ? t("doc.receipt") : credit ? t("doc.creditInvoice") : t("doc.invoice"));

  async function send(type: DocType) {
    setNotice(null);
    setBusy(type);
    try {
      const response = await api(`/api/v1/sales/${saleId}/documents/${type}`);
      if (!response.ok) throw new Error("failed");
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `${type}.pdf`;
      const file = new File([blob], name, { type: "application/pdf" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name, text: whatsAppText.trim() });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      // No file sharing here (most computers): save the PDF, and offer WhatsApp with a download link.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(t("docSaved", { name }));
    } catch {
      setNotice(t("docFailed"));
    } finally {
      setBusy(null);
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const token = receiptPath.split("/").pop() ?? "";
  const primary = documents.includes("receipt") ? "receipt" : documents[0];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {documents.map((type) => (
          <Button key={type} type="button" variant={type === primary ? "primary" : "secondary"} disabled={busy !== null} onClick={() => void send(type)}>
            {busy === type ? t("docPreparing") : t("docSend", { doc: label(type) })}
          </Button>
        ))}
      </div>
      {notice ? (
        <p className="text-sm text-muted" role="status">
          {notice}{" "}
          {primary ? (
            <a
              className="text-primary"
              target="_blank"
              rel="noreferrer"
              href={`${whatsAppPrefix}?text=${encodeURIComponent(`${whatsAppText}${origin}/api/v1/public/receipts/${token}/documents/${primary}.pdf`)}`}
            >
              {t("docWhatsAppLink")}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
