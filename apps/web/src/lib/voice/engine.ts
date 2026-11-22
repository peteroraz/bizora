import registry from "./models.json";
import type { WorkerMessage, WorkerRequest } from "./speech.worker";

/**
 * Offline voice on this phone (ADR-040): what the device can do, whether the speech model is installed, installing it
 * with progress, and turning recorded audio into words. No audio or words ever leave the phone from here.
 */
export type SpeechModel = (typeof registry.models)[number];
export const RUNTIME = registry.runtime;

/**
 * Two models (ADR-041): Standard (Whisper base, about 80 MB) for every phone, and Best accuracy (Whisper small, about
 * 250 MB) for phones with the memory and room. One is kept on the phone at a time.
 */
export type VoiceTier = "standard" | "best";
const TIER_KEY = "bizora.voice.tier";
export const modelFor = (tier: VoiceTier): SpeechModel => registry.models.find((model) => model.tier === tier) ?? registry.models[0]!;
export function chosenTier(): VoiceTier {
  try {
    return window.localStorage.getItem(TIER_KEY) === "best" ? "best" : "standard";
  } catch {
    return "standard";
  }
}
export function chooseTier(tier: VoiceTier) {
  try {
    window.localStorage.setItem(TIER_KEY, tier);
  } catch {
    // Without storage the phone uses Standard.
  }
  engine.reset();
}
export const speechModel = () => modelFor(chosenTier());
/** Best accuracy needs about 1 GB of memory while it works: offered on phones with 4 GB or more (or that do not say). */
export function bestFits() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory >= 4;
}

const MARKER = "bizora.voice.installed";
/** Every cache this feature has ever used starts with this, so old versions can be removed. */
const CACHE_PREFIX = "bizora-voice-";

export function cacheName(model: SpeechModel = speechModel()) {
  return `${CACHE_PREFIX}${model.id}-v${model.version}-ort${RUNTIME.version}`;
}
export const modelPath = (model: SpeechModel = speechModel()) => `/voice/models/${model.version}/`;
export const runtimePath = () => `/voice/ort/${RUNTIME.version}/`;

export type Support = {
  ok: boolean;
  /** Why voice cannot run here, in order of importance. */
  missing: ("worker" | "wasm" | "microphone" | "recorder" | "audio" | "storage" | "secure")[];
  webgpu: boolean;
};

/** What this browser can do. WebGPU is a bonus; without it everything runs on the processor. */
export async function detectSupport(): Promise<Support> {
  const missing: Support["missing"] = [];
  if (typeof window === "undefined") return { ok: false, missing: ["worker"], webgpu: false };
  if (!window.isSecureContext) missing.push("secure");
  if (typeof Worker === "undefined") missing.push("worker");
  if (typeof WebAssembly === "undefined") missing.push("wasm");
  if (!navigator.mediaDevices?.getUserMedia) missing.push("microphone");
  if (typeof MediaRecorder === "undefined") missing.push("recorder");
  if (typeof AudioContext === "undefined" && !("webkitAudioContext" in window)) missing.push("audio");
  if (typeof caches === "undefined") missing.push("storage");
  let webgpu = false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    webgpu = Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    webgpu = false;
  }
  return { ok: missing.length === 0, missing, webgpu };
}

type Marker = { cache: string; keys: string[]; bytes: number; device: "wasm" | "webgpu"; installedAt: string };

function readMarker(): Marker | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MARKER) ?? "null") as Marker | null;
    return parsed && parsed.cache === cacheName() ? parsed : null;
  } catch {
    return null;
  }
}

export type InstallState =
  | { status: "installed"; bytes: number; device: "wasm" | "webgpu"; installedAt: string }
  | { status: "missing" }
  /** It was installed, but the phone removed some files to free space. */
  | { status: "evicted" };

/** Whether this phone has the current model, checked against the files actually kept, not only a note. */
export async function installState(): Promise<InstallState> {
  if (typeof caches === "undefined") return { status: "missing" };
  const marker = readMarker();
  if (!marker) return { status: "missing" };
  try {
    const cache = await caches.open(marker.cache);
    const keys = new Set((await cache.keys()).map((request) => request.url));
    const complete = marker.keys.length > 0 && marker.keys.every((key) => keys.has(key));
    return complete ? { status: "installed", bytes: marker.bytes, device: marker.device, installedAt: marker.installedAt } : { status: "evicted" };
  } catch {
    return { status: "evicted" };
  }
}

/** Room left for this site, if the browser says. */
export async function storageRoom(): Promise<{ free: number | null; persisted: boolean }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const free = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : null;
    return { free, persisted };
  } catch {
    return { free: null, persisted: false };
  }
}

/** The download size: the model as the server lists it, plus the runtime this device needs. */
export async function downloadSize(webgpu: boolean, chosen: SpeechModel = speechModel()): Promise<number> {
  let model = chosen.approxBytes;
  try {
    const response = await fetch(`${modelPath(chosen)}${chosen.id}/bizora-manifest.json`, { cache: "no-store" });
    if (response.ok) model = ((await response.json()) as { bytes: number }).bytes || model;
  } catch {
    // Offline or not yet published: the registry's estimate.
  }
  return model + (webgpu ? 27_000_000 : 14_300_000);
}

/** Whether the server has the model at all (it is downloaded at build time). */
export async function modelPublished(): Promise<boolean> {
  try {
    const chosen = speechModel();
    const response = await fetch(`${modelPath(chosen)}${chosen.id}/config.json`, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export class VoiceError extends Error {
  constructor(
    public readonly code: "no_room" | "not_published" | "download_failed" | "unsupported" | "transcribe_failed" | "busy",
    message: string,
  ) {
    super(message);
  }
}

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };

/**
 * One speech engine per page. Loading reads the model from this phone's cache (or downloads it the first time) and
 * keeps it in memory until the page closes.
 */
class Engine {
  private worker: Worker | null = null;
  private ready: Promise<"wasm" | "webgpu"> | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();

  load(options: { device: "wasm" | "webgpu"; onProgress?: (loaded: number, total: number) => void }): Promise<"wasm" | "webgpu"> {
    if (this.ready) return this.ready;
    const worker = new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const files = new Map<string, { loaded: number; total: number }>();
    this.ready = new Promise<"wasm" | "webgpu">((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === "progress") {
          files.set(message.file, { loaded: message.loaded, total: message.total });
          let loaded = 0;
          let total = 0;
          for (const file of files.values()) {
            loaded += file.loaded;
            total += file.total;
          }
          options.onProgress?.(loaded, total);
        } else if (message.type === "ready") {
          resolve(message.device);
        } else if (message.type === "result") {
          this.pending.get(message.id)?.resolve(message.text);
          this.pending.delete(message.id);
        } else if (message.type === "error") {
          if (message.stage === "load") {
            this.reset();
            reject(new VoiceError("download_failed", message.message));
          } else if (message.id !== undefined) {
            this.pending.get(message.id)?.reject(new VoiceError("transcribe_failed", message.message));
            this.pending.delete(message.id);
          }
        }
      };
      worker.onerror = (event) => {
        this.reset();
        reject(new VoiceError("download_failed", event.message || "Voice could not start."));
      };
    });
    const request: WorkerRequest = {
      type: "load",
      modelPath: modelPath(),
      modelId: speechModel().id,
      cacheName: cacheName(),
      runtimePath: runtimePath(),
      runtimeFile: options.device === "webgpu" ? RUNTIME.gpu : RUNTIME.cpu,
      device: options.device,
      dtype: speechModel().dtype,
    };
    worker.postMessage(request);
    return this.ready;
  }

  /** The prompt names this shop's products and customers, so the model expects them (ADR-041). */
  transcribe(audio: Float32Array, prompt?: string): Promise<string> {
    if (!this.worker) return Promise.reject(new VoiceError("unsupported", "Voice is not ready."));
    const id = this.next++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // The buffer moves to the worker; this page no longer holds the sound.
      this.worker!.postMessage({ type: "transcribe", id, audio, ...(prompt ? { prompt } : {}) } satisfies WorkerRequest, [audio.buffer]);
    });
  }

  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const pending of this.pending.values()) pending.reject(new VoiceError("transcribe_failed", "Voice stopped."));
    this.pending.clear();
  }
}

export const engine = new Engine();

/**
 * Downloads the model and runtime once, checks there is room first, and notes which files make it up so a later
 * visit can tell whether the phone removed any of them.
 */
export async function install(onProgress: (loaded: number, total: number) => void): Promise<InstallState> {
  const support = await detectSupport();
  if (!support.ok) throw new VoiceError("unsupported", support.missing.join(", "));
  if (!(await modelPublished())) throw new VoiceError("not_published", "The speech model is not on this server yet.");
  const needed = await downloadSize(support.webgpu);
  const room = await storageRoom();
  if (room.free !== null && room.free < needed * 1.2) throw new VoiceError("no_room", String(needed));
  // Ask the browser not to clear these files when space runs low (it may still, if the person clears site data).
  await navigator.storage?.persist?.().catch(() => false);
  await removeOldVersions();
  let device: "wasm" | "webgpu" = support.webgpu ? "webgpu" : "wasm";
  try {
    device = await engine.load({ device, onProgress });
  } catch (error) {
    if (device !== "webgpu") throw error;
    // WebGPU said yes but could not run the model: fall back to the processor.
    engine.reset();
    device = await engine.load({ device: "wasm", onProgress });
  }
  const cache = await caches.open(cacheName());
  const keys = (await cache.keys()).map((request) => request.url);
  let bytes = 0;
  for (const key of keys) {
    const response = await cache.match(key);
    bytes += Number(response?.headers.get("content-length") ?? 0);
  }
  const marker: Marker = { cache: cacheName(), keys, bytes: bytes || needed, device, installedAt: new Date().toISOString() };
  window.localStorage.setItem(MARKER, JSON.stringify(marker));
  return { status: "installed", bytes: marker.bytes, device, installedAt: marker.installedAt };
}

/** Loads the installed model into memory (no network needed). */
export async function prepare(): Promise<"wasm" | "webgpu"> {
  const marker = readMarker();
  return engine.load({ device: marker?.device ?? "wasm" });
}

export async function removeOldVersions() {
  if (typeof caches === "undefined") return;
  const current = cacheName();
  for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== current) await caches.delete(key);
}

/** Deletes the model from this phone. Sales are not touched. */
export async function uninstall() {
  engine.reset();
  if (typeof caches !== "undefined") for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX)) await caches.delete(key);
  window.localStorage.removeItem(MARKER);
}
