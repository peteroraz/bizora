import { describe, expect, it } from "vitest";
import { cleanUp, tidyWords } from "./clean";

const RATE = 16_000;
const tone = (seconds: number, level: number, hz = 300) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => level * Math.sin((2 * Math.PI * hz * index) / RATE));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("tidying a recording before reading it", () => {
  it("trims long silence around the speech and brings quiet speech up", () => {
    const quietSpeech = tone(2, 0.02);
    const result = cleanUp(join(new Float32Array(3 * RATE), quietSpeech, new Float32Array(4 * RATE)));
    expect(result.heard).toBe(true);
    expect(result.seconds).toBeGreaterThan(2);
    expect(result.seconds).toBeLessThan(2.8);
    const peak = result.audio.reduce((top, value) => Math.max(top, Math.abs(value)), 0);
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThanOrEqual(0.91);
  });

  it("says nothing was heard for silence or a tap", () => {
    expect(cleanUp(new Float32Array(2 * RATE)).heard).toBe(false);
    expect(cleanUp(join(new Float32Array(RATE), tone(0.05, 0.5), new Float32Array(RATE))).heard).toBe(false);
    expect(cleanUp(new Float32Array(0)).heard).toBe(false);
  });

  it("removes low hum", () => {
    const hum = tone(1, 0.3, 30);
    const result = cleanUp(join(hum, tone(1, 0.3, 400)));
    const firstHalf = result.audio.slice(0, RATE / 2).reduce((top, value) => Math.max(top, Math.abs(value)), 0);
    const speech = result.audio.slice(-RATE / 2).reduce((top, value) => Math.max(top, Math.abs(value)), 0);
    expect(firstHalf).toBeLessThan(speech / 2);
  });

  it("drops words the model writes for silence or music", () => {
    expect(tidyWords(" [BLANK_AUDIO] ")).toBe("");
    expect(tidyWords("Thank you.")).toBe("");
    expect(tidyWords("(music) Two bags of rice, cash. ♪")).toBe("Two bags of rice, cash.");
    expect(tidyWords("Two bags of rice, thank you.")).toBe("Two bags of rice, thank you.");
  });
});
