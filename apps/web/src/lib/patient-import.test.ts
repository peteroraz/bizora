import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patientImport } from "./patient-import";

describe("a part of the sale screen that could not load yet", () => {
  let listeners: Record<string, (() => void)[]>;
  beforeEach(() => {
    vi.useFakeTimers();
    listeners = {};
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: () => void) => (listeners[name] ??= []).push(listener),
      removeEventListener: (name: string, listener: () => void) => (listeners[name] = (listeners[name] ?? []).filter((item) => item !== listener)),
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the network instead of failing, then loads once it is back", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("ChunkLoadError: Loading chunk 4521 failed.")).mockResolvedValue({ part: "lines" });
    const loaded = patientImport(load)();
    let settled = false;
    void loaded.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    for (const listener of listeners.online ?? []) listener();
    await expect(loaded).resolves.toEqual({ part: "lines" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(listeners.online).toHaveLength(0);
  });

  it("tries again every few seconds when no online event comes", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ok");
    const loaded = patientImport(load, 5_000)();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(loaded).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("shares one load between the warm-up and the screen", async () => {
    const load = vi.fn().mockResolvedValue("ok");
    const part = patientImport(load);
    await Promise.all([part(), part()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
