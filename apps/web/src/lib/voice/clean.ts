/**
 * Tidies a recording before it is turned into words (ADR-041): removes low hum and wind rumble, trims the silence
 * before and after speaking, and brings quiet speech up to a steady level. Cheap phone microphones and shouting
 * across a market both read better this way, and less silence means less time and fewer invented words.
 */
const RATE = 16_000;
const FRAME = 320; // 20 ms
const KEEP = Math.round(0.25 * RATE); // a little silence either side helps the model start and end cleanly

export type Cleaned = { audio: Float32Array; heard: boolean; seconds: number };

export function cleanUp(input: Float32Array): Cleaned {
  if (input.length === 0) return { audio: input, heard: false, seconds: 0 };
  // High-pass at about 80 Hz: speech is above it, hum and handling noise mostly below. Also removes any DC offset.
  const alpha = 1 / (1 + (2 * Math.PI * 80) / RATE);
  const filtered = new Float32Array(input.length);
  let previousIn = input[0] ?? 0;
  let previousOut = 0;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] ?? 0;
    previousOut = alpha * (previousOut + value - previousIn);
    previousIn = value;
    filtered[index] = previousOut;
  }
  // Loudness per 20 ms frame; speech is well above the quietest frames (the room's own noise).
  const frames = Math.ceil(filtered.length / FRAME);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const end = Math.min(filtered.length, (frame + 1) * FRAME);
    for (let index = frame * FRAME; index < end; index += 1) sum += (filtered[index] ?? 0) ** 2;
    energy[frame] = Math.sqrt(sum / Math.max(1, end - frame * FRAME));
  }
  const sorted = Float32Array.from(energy).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const loudest = sorted[sorted.length - 1] ?? 0;
  const threshold = Math.max(0.004, floor * 3, loudest * 0.08);
  let first = energy.findIndex((value) => value > threshold);
  let last = frames - 1;
  while (last >= 0 && (energy[last] ?? 0) <= threshold) last -= 1;
  const voiced = first < 0 ? 0 : energy.filter((value) => value > threshold).length;
  // Under about a quarter of a second of anything louder than the room: nothing was said.
  if (first < 0 || voiced * FRAME < 0.25 * RATE || loudest < 0.004) return { audio: filtered, heard: false, seconds: filtered.length / RATE };
  first = Math.max(0, first * FRAME - KEEP);
  const end = Math.min(filtered.length, (last + 1) * FRAME + KEEP);
  const trimmed = filtered.slice(first, end);
  // Bring the loudest part to about 90%, but never boost more than 20 times (that would only raise the noise).
  let peak = 0;
  for (const value of trimmed) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? Math.min(20, 0.9 / peak) : 1;
  if (gain !== 1) for (let index = 0; index < trimmed.length; index += 1) trimmed[index] = (trimmed[index] ?? 0) * gain;
  return { audio: trimmed, heard: true, seconds: trimmed.length / RATE };
}

/** Words the model writes for silence, music or noise, never said by the trader. */
const NOT_SPEECH = /\[(?:blank_audio|music|noise|silence|inaudible)[^\]]*\]|\((?:music|noise|silence|inaudible|laughs?|applause)[^)]*\)|♪+/gi;
const ONLY_FILLER = /^(?:thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+)$/i;

export function tidyWords(text: string) {
  const cleaned = text.replace(NOT_SPEECH, " ").replace(/\s+/g, " ").trim();
  return ONLY_FILLER.test(cleaned) ? "" : cleaned;
}
