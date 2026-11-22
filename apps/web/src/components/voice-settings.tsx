"use client";

import { Button, Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  bestFits,
  chooseTier,
  chosenTier,
  detectSupport,
  downloadSize,
  install,
  installState,
  modelFor,
  speechModel,
  storageRoom,
  uninstall,
  type InstallState,
  type VoiceTier,
} from "../lib/voice/engine";

/**
 * Offline voice on this phone (ADR-040, ADR-041): whether it is set up, which model (Standard or Best accuracy), how
 * much room it takes, download or remove it. One model is kept at a time; downloading the other replaces it.
 */
export function VoiceSettings() {
  const t = useTranslations("settings.voice");
  const [state, setState] = useState<InstallState | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [webgpu, setWebgpu] = useState(false);
  const [tier, setTier] = useState<VoiceTier>("standard");
  const [sizes, setSizes] = useState<Record<VoiceTier, number>>({ standard: 0, best: 0 });
  const [free, setFree] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function refresh() {
    const support = await detectSupport();
    setSupported(support.ok);
    setWebgpu(support.webgpu);
    setTier(chosenTier());
    setState(await installState());
    setSizes({ standard: await downloadSize(support.webgpu, modelFor("standard")), best: await downloadSize(support.webgpu, modelFor("best")) });
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

  async function pick(next: VoiceTier) {
    chooseTier(next);
    setTier(next);
    setState(await installState());
  }

  const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  const installedHere = state?.status === "installed";
  return (
    <Card className="space-y-3" data-testid="voice-settings">
      <div>
        <p className="font-medium">{t("title")}</p>
        <p className="text-sm text-muted">{t("lead")}</p>
      </div>
      {supported === false ? <p className="text-sm">{t("unsupported")}</p> : null}
      {supported ? (
        <fieldset className="space-y-2" data-testid="voice-tier">
          <legend className="text-sm font-medium">{t("tierTitle")}</legend>
          {(["standard", "best"] as const).map((option) => (
            <label key={option} className="flex items-start gap-2 text-sm">
              <input type="radio" name="voice-tier" className="mt-1" checked={tier === option} disabled={progress !== null} onChange={() => void pick(option)} />
              <span>
                <span className="block font-medium">{t(`tier.${option}`, { size: mb(sizes[option] || modelFor(option).approxBytes) })}</span>
                <span className="block text-muted">{t(`tierHint.${option}`)}</span>
                {option === "best" && !bestFits() ? <span className="block text-warning">{t("bestTooBig")}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {installedHere ? (
        <p className="text-sm">{t("installed", { size: mb(state.bytes), device: state.device === "webgpu" ? t("gpu") : t("cpu"), model: speechModel().label })}</p>
      ) : state?.status === "evicted" ? (
        <p className="text-sm text-warning">{t("evicted")}</p>
      ) : supported ? (
        <p className="text-sm">{t("missing", { size: mb(sizes[tier] || speechModel().approxBytes) })}</p>
      ) : null}
      {free !== null ? <p className="text-xs text-muted">{t("free", { size: mb(free) })}</p> : null}
      {progress !== null ? <p className="text-sm">{t("downloading", { percent: progress })}</p> : null}
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {supported && !installedHere && progress === null ? <Button onClick={() => void download()}>{t("download")}</Button> : null}
        {installedHere || state?.status === "evicted" ? (
          <Button variant="secondary" onClick={() => void remove()}>
            {t("remove")}
          </Button>
        ) : null}
      </div>
      {webgpu ? <p className="text-xs text-muted">{t("gpuNote")}</p> : null}
    </Card>
  );
}
