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
  | { type: "transcribe"; id: number; audio: Float32Array; prompt?: string }
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

/** About 8 tokens a second of speech, plus a little: enough for any sale said, never a runaway repeat (ADR-041). */
const capFor = (audio: Float32Array) => Math.min(440, Math.ceil((audio.length / 16_000) * 8) + 16);

type WhisperParts = {
  tokenizer: { convert_tokens_to_ids: (tokens: string[]) => number[]; encode: (text: string, options: { add_special_tokens: boolean }) => number[]; decode: (ids: number[], options: { skip_special_tokens: boolean }) => string };
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: { config: { model_type?: string }; generation_config: unknown; _retrieve_init_tokens: (config: unknown) => number[]; generate: (options: Record<string, unknown>) => Promise<{ tolist: () => (number | bigint)[][] }> };
};

/**
 * Reads one recording. With a prompt (this shop's product and customer names, the currency), Whisper is told these
 * words came just before, so it writes "naira" and "Emeka" rather than "near a" and "America". The library has no
 * prompt option, so the prompt goes in as the first tokens, as Whisper was trained to expect (ADR-041).
 */
async function read(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array, prompt?: string): Promise<string> {
  const cap = capFor(audio);
  const parts = asr as unknown as WhisperParts;
  if (prompt && parts.model.config.model_type === "whisper") {
    const [previous] = parts.tokenizer.convert_tokens_to_ids(["<|startofprev|>"]);
    const promptIds = parts.tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).slice(-180);
    const init = [previous!, ...promptIds, ...parts.model._retrieve_init_tokens(parts.model.generation_config)];
    const { input_features } = await parts.processor(audio);
    const output = await parts.model.generate({ inputs: input_features, decoder_input_ids: init, max_new_tokens: Math.min(440 - init.length, cap) });
    const ids = (output.tolist()[0] ?? []).slice(init.length).map(Number);
    return parts.tokenizer.decode(ids, { skip_special_tokens: true });
  }
  const output = (await asr(audio, { chunk_length_s: 30, max_new_tokens: cap } as never)) as { text: string } | { text: string }[];
  return Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text;
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
      const text = (await read(recognizer, request.audio, request.prompt)).trim();
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
