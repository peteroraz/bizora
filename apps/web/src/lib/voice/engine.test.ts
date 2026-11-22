import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheName, installState, runtimePath, speechModel } from "./engine";

// A tiny stand-in for the browser's file cache and local notes.
function browser(files: string[]) {
  const store = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
  vi.stubGlobal("localStorage", (globalThis as unknown as { window: { localStorage: unknown } }).window.localStorage);
  vi.stubGlobal("caches", { open: async () => ({ keys: async () => files.map((url) => ({ url })) }) });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("offline voice set-up", () => {
  it("names the cache after the model and runtime versions, so a new version never mixes with an old one", () => {
    expect(cacheName()).toBe(`bizora-voice-${speechModel().id}-v${speechModel().version}-ort${runtimePath().split("/")[3]}`);
    expect(runtimePath()).toMatch(/^\/voice\/ort\/[^/]+\/$/);
  });

  it("is installed only when every noted file is still on the phone", async () => {
    const store = browser(["https://shop.test/a.onnx", "https://shop.test/b.json"]);
    expect(await installState()).toEqual({ status: "missing" });
    store.set("bizora.voice.installed", JSON.stringify({ cache: cacheName(), keys: ["https://shop.test/a.onnx", "https://shop.test/b.json"], bytes: 80_000_000, device: "wasm", installedAt: "2026-11-20T10:00:00Z" }));
    expect(await installState()).toMatchObject({ status: "installed", bytes: 80_000_000, device: "wasm" });
  });

  it("notices when the phone removed files to free space", async () => {
    const store = browser(["https://shop.test/b.json"]);
    store.set("bizora.voice.installed", JSON.stringify({ cache: cacheName(), keys: ["https://shop.test/a.onnx", "https://shop.test/b.json"], bytes: 1, device: "wasm", installedAt: "x" }));
    expect(await installState()).toEqual({ status: "evicted" });
  });
});
