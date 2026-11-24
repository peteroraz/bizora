"use client";

import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useEffect, useState } from "react";

// The camera reader is loaded only when someone taps Scan, so screens stay light (ADR-066).
const BarcodeScanner = lazy(() => import("./barcode-scanner").then((module) => ({ default: module.BarcodeScanner })));

/**
 * A Scan button beside a box where a barcode can be typed. It shows only where the browser can read barcodes from
 * the camera (Chrome on Android, for example); elsewhere the person types the code as before.
 */
export function ScanButton({ onCode, label }: { onCode: (code: string) => void; label?: string }) {
  const t = useTranslations("scan");
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);

  if (!supported) return null;
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} aria-label={label ?? t("button")} data-testid="scan-button">
        {t("button")}
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <BarcodeScanner
            onCode={(code) => {
              setOpen(false);
              onCode(code);
            }}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
