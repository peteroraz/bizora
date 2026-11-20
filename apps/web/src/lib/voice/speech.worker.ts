/// <reference lib="webworker" />
/**
 * Speech to text on the phone (ADR-040), in its own thread so the screen never freezes. Uses Whisper through
 * Transformers.js and ONNX Runtime (WebAssembly, or WebGPU where the phone has it). Every file comes from Bizora's own
 * address and is kept in this model's own cache, so after the first download it works with no network.
 * Audio arrives as numbers in memory and is dropped after it is read; nothing is stored or sent anywhere.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

export type WorkerRequest =
  | {
      type: "load";
      modelPath: string;
      modelId: string;
      cacheName: string;
      runtimePath: string;
      runtimeFile: string;
      device: "wasm" | "webgpu";
      dtype: Record<string, string>;
    }
  | { type: "transcribe"; id: number; audio: Float32Array }
  | { type: "dispose" };

export type WorkerMessage =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready"; device: "wasm" | "webgpu"; ms: number }
  | { type: "result"; id: number; text: string; ms: number }
  | { type: "error"; id?: number; message: string; stage: "load" | "transcribe" };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let recognizer: AutomaticSpeechRecognitionPipeline | null = null;

function post(message: WorkerMessage) {
  scope.postMessage(message);
}

async function load(request: Extract<WorkerRequest, { type: "load" }>) {
  const started = performance.now();
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = request.modelPath;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = await caches.open(request.cacheName);
  // The runtime is fetched by the runtime itself, not through the cache above, so it is saved here once; with no
  // network the site's service worker then serves it from this cache.
  const runtimeFiles = [`${request.runtimePath}${request.runtimeFile}.wasm`, `${request.runtimePath}${request.runtimeFile}.mjs`];
  for (const file of runtimeFiles) {
    const url = new URL(file, scope.location.origin).href;
    if (await env.customCache.match(url)) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    await env.customCache.put(url, response);
    post({ type: "progress", file, loaded: size, total: size });
  }
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = { wasm: `${request.runtimePath}${request.runtimeFile}.wasm`, mjs: `${request.runtimePath}${request.runtimeFile}.mjs` } as never;
    // Without cross-origin isolation the browser gives one thread; asking for more only adds warnings.
    wasm.numThreads = 1;
  }
  recognizer = (await pipeline("automatic-speech-recognition", request.modelId, {
    device: request.device,
    dtype: request.dtype as never,
    progress_callback: (data: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (data.status === "progress" && data.file) post({ type: "progress", file: data.file, loaded: data.loaded ?? 0, total: data.total ?? 0 });
    },
  })) as AutomaticSpeechRecognitionPipeline;
  // One short silent run, so the first real recording is not slowed by setting up.
  await recognizer(new Float32Array(16_000));
  post({ type: "ready", device: request.device, ms: Math.round(performance.now() - started) });
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "load") {
    try {
      await load(request);
    } catch (error) {
      post({ type: "error", stage: "load", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.type === "transcribe") {
    if (!recognizer) {
      post({ type: "error", id: request.id, stage: "transcribe", message: "Voice is not ready yet." });
      return;
    }
    const started = performance.now();
    try {
      const output = (await recognizer(request.audio, { chunk_length_s: 30 })) as { text: string } | { text: string }[];
      const text = (Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text).trim();
      post({ type: "result", id: request.id, text, ms: Math.round(performance.now() - started) });
    } catch (error) {
      post({ type: "error", id: request.id, stage: "transcribe", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.type === "dispose") {
    await recognizer?.dispose();
    recognizer = null;
    scope.close();
  }
};
