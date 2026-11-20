"use client";

import { Button, Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { detectSupport, downloadSize, install, installState, SPEECH_MODEL, storageRoom, uninstall, type InstallState } from "../lib/voice/engine";

/** Offline voice on this phone (ADR-040): whether it is set up, how much room it takes, download or remove it. */
export function VoiceSettings() {
  const t = useTranslations("settings.voice");
  const [state, setState] = useState<InstallState | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [size, setSize] = useState(0);
  const [free, setFree] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function refresh() {
    const support = await detectSupport();
    setSupported(support.ok);
    setState(await installState());
    setSize(await downloadSize(support.webgpu));
    setFree((await storageRoom()).free);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function download() {
    setProblem(null);
    setProgress(0);
    try {
      await install((loaded, total) => setProgress(total > 0 ? Math.round((loaded / total) * 100) : 0));
    } catch {
      setProblem(t("failed"));
    } finally {
      setProgress(null);
      await refresh();
    }
  }

  async function remove() {
    await uninstall();
    await refresh();
  }

  const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  return (
    <Card className="space-y-3" data-testid="voice-settings">
      <div>
        <p className="font-medium">{t("title")}</p>
        <p className="text-sm text-muted">{t("lead")}</p>
      </div>
      {supported === false ? <p className="text-sm">{t("unsupported")}</p> : null}
      {state?.status === "installed" ? (
        <p className="text-sm">{t("installed", { size: mb(state.bytes), device: state.device === "webgpu" ? t("gpu") : t("cpu"), model: SPEECH_MODEL.label })}</p>
      ) : state?.status === "evicted" ? (
        <p className="text-sm text-warning">{t("evicted")}</p>
      ) : supported ? (
        <p className="text-sm">{t("missing", { size: mb(size) })}</p>
      ) : null}
      {free !== null ? <p className="text-xs text-muted">{t("free", { size: mb(free) })}</p> : null}
      {progress !== null ? <p className="text-sm">{t("downloading", { percent: progress })}</p> : null}
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {supported && state?.status !== "installed" && progress === null ? <Button onClick={() => void download()}>{t("download")}</Button> : null}
        {state?.status === "installed" || state?.status === "evicted" ? (
          <Button variant="secondary" onClick={() => void remove()}>
            {t("remove")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
