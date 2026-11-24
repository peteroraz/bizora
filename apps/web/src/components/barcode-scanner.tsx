"use client";

import { Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/** What the browser's barcode reader gives back (the Shape Detection API, not in every browser). */
type DetectedBarcode = { rawValue: string; format: string };
type Detector = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type DetectorClass = { new (options?: { formats?: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

/** The codes shops meet: product barcodes, carton codes, and QR on newer packs. */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

function detectorClass(): DetectorClass | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector ?? null) as DetectorClass | null;
}

/** Whether this browser can read barcodes from the camera. Where it cannot, people type the code. */
export function canScanBarcodes() {
  return Boolean(detectorClass()) && typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Reads one barcode with the phone's back camera (ADR-066), then closes. Uses the browser's own BarcodeDetector,
 * so nothing extra is downloaded; where the browser has none, or the camera is refused, it says so and the person
 * types the code instead. The picture never leaves the phone.
 */
export function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const t = useTranslations("scan");
  const video = useRef<HTMLVideoElement>(null);
  // The latest handler, so a new one from the page does not restart the camera.
  const handler = useRef(onCode);
  handler.current = onCode;
  const [problem, setProblem] = useState<string | null>(canScanBarcodes() ? null : t("notSupported"));

  useEffect(() => {
    const Detector = detectorClass();
    if (!Detector || !canScanBarcodes()) return;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    void (async () => {
      try {
        const supported = (await Detector.getSupportedFormats?.()) ?? FORMATS;
        const detector = new Detector({ formats: FORMATS.filter((format) => supported.includes(format)) });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped || !video.current) return stop();
        video.current.srcObject = stream;
        // Not waited for: reading starts at once, and a frame not ready yet is simply tried again.
        void video.current.play().catch(() => undefined);
        const look = async () => {
          if (stopped || !video.current) return;
          try {
            const [found] = await detector.detect(video.current);
            const code = found?.rawValue.trim();
            if (code) {
              stop();
              if (typeof navigator.vibrate === "function") navigator.vibrate(60);
              handler.current(code);
              return;
            }
          } catch {
            // A frame that could not be read; try the next one.
          }
          timer = window.setTimeout(() => void look(), 180);
        };
        void look();
      } catch (error) {
        setProblem((error as { name?: string }).name === "NotAllowedError" ? t("cameraRefused") : t("cameraFailed"));
        stop();
      }
    })();
    return stop;
  }, [t]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4 text-white" role="dialog" aria-modal="true" aria-label={t("title")} data-testid="barcode-scanner">
      <p className="text-base font-semibold">{t("title")}</p>
      <p className="text-sm opacity-80">{problem ?? t("hint")}</p>
      {problem ? null : (
        <div className="relative mt-4 flex-1 overflow-hidden rounded-card">
          <video ref={video} className="h-full w-full object-cover" playsInline muted />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-control border-2 border-white/80" />
        </div>
      )}
      <Button className="mt-4" variant="secondary" onClick={onClose}>
        {problem ? t("typeInstead") : t("cancel")}
      </Button>
    </div>
  );
}
