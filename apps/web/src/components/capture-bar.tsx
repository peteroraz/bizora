"use client";

import type { CaptureResult, CaptureTarget } from "@bizora/contracts";
import { CAPTURE_MAX_AUDIO_SECONDS, CAPTURE_MAX_FILES } from "@bizora/contracts";
import { Button } from "@bizora/ui";
import { Camera, Mic, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { blobToCapture, fileToCapture, recordingType } from "../lib/capture-client";

type Status = { enabled: boolean; remainingToday: number; targets: CaptureTarget[] };

/**
 * Photo, scan and voice note capture (ADR-018). The AI's rows are added to the review table as drafts; nothing is
 * saved until the person checks the rows and presses Save.
 */
export function CaptureBar({ target, onRows }: { target: CaptureTarget; onRows: (result: CaptureResult) => void }) {
  const t = useTranslations("capture");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [note, setNote] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void api("/api/v1/captures/status")
      .then(async (response) => (response.ok ? setStatus((await response.json()).data) : undefined))
      .catch(() => undefined);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  if (!status?.enabled || !status.targets.includes(target)) return null;

  async function send(files: { mimeType: string; data: string }[]) {
    setError(null);
    setBusy(true);
    try {
      const response = await api("/api/v1/captures", { method: "POST", body: JSON.stringify({ target, files, ...(note.trim() ? { note: note.trim() } : {}) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? t("failed"));
        return;
      }
      const result = payload.data as CaptureResult;
      setStatus((current) => (current ? { ...current, remainingToday: result.remainingToday } : current));
      if (result.rows.length === 0) setError(t("nothingRead"));
      onRows(result);
    } catch {
      setError(t("offline"));
    } finally {
      setBusy(false);
    }
  }

  async function pickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    if (list.length > CAPTURE_MAX_FILES) {
      setError(t("tooManyFiles", { max: CAPTURE_MAX_FILES }));
      return;
    }
    setBusy(true);
    const files = await Promise.all(Array.from(list).map((file) => fileToCapture(file)));
    await send(files);
  }

  async function startRecording() {
    setError(null);
    const type = recordingType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) {
      setError(t("noRecording"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (timer.current) window.clearInterval(timer.current);
        setRecording(false);
        const blob = new Blob(chunks, { type: media.mimeType || type || "audio/webm" });
        if (blob.size > 0) void blobToCapture(blob).then((file) => send([file]));
      };
      recorder.current = media;
      media.start(1000);
      setSeconds(0);
      setRecording(true);
      timer.current = window.setInterval(() => {
        setSeconds((value) => {
          if (value + 1 >= CAPTURE_MAX_AUDIO_SECONDS) recorder.current?.stop();
          return value + 1;
        });
      }, 1000);
    } catch {
      setError(t("micDenied"));
    }
  }

  return (
    <div className="space-y-2 rounded-card border border-dashed border-primary/50 bg-primary/5 p-4">
      <p className="text-sm font-medium">{t(`title.${target}`)}</p>
      <p className="text-sm text-muted">{t("lead")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-fg ${busy || recording ? "pointer-events-none opacity-60" : ""}`}>
          <Camera className="h-4 w-4" aria-hidden="true" />
          {t("photo")}
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="sr-only"
            aria-label={t("photo")}
            disabled={busy || recording}
            onChange={(event) => {
              void pickFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        {recording ? (
          <Button type="button" variant="secondary" onClick={() => recorder.current?.stop()}>
            <Square className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("stop", { seconds })}
          </Button>
        ) : (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void startRecording()}>
            <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("voice")}
          </Button>
        )}
        <span className="text-xs text-muted">{t("remaining", { count: status.remainingToday })}</span>
      </div>
      <label className="block text-sm">
        <span className="text-muted">{t("noteLabel")}</span>
        <input className="mt-1 w-full rounded-control border border-border bg-background px-2 py-1" value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
      </label>
      {busy ? (
        <p className="text-sm" role="status">
          {t("reading")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
