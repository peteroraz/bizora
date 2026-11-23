// Offline voice benchmark (ADR-041). Compares speech models on Nigerian English and on spoken sales, so the model
// Bizora ships is chosen on evidence. Runs in CI (.github/workflows/voice-benchmark.yml), never on phones.
//
//   node scripts/voice-benchmark.mjs <nigerian-dir> <sales-dir>
//
// <nigerian-dir>: WAV files plus index.tsv (file<TAB>sentence), from OpenSLR SLR70 (CC BY-SA 4.0), not shipped.
// <sales-dir>:    WAV files plus index.tsv (file<TAB>sentence) of spoken sales.
// Each clip is read as recorded and again with market noise (other voices mixed in at 5 dB), as phones hear it.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import console from "node:console";
import { env, pipeline } from "@huggingface/transformers";
import { parseSpokenSale } from "@bizora/contracts/voice";

env.allowRemoteModels = true;
env.cacheDir = process.env.VOICE_BENCH_CACHE ?? ".cache/voice-bench";

const [nigerianDir, salesDir, pidginDir] = process.argv.slice(2);
const PROMPT = "Sold in naira, cash, transfer or POS. Rice, Peak Milk, Indomie, garri, palm oil, sugar, semovita, Coke. Emeka, Chioma, Mama Nkechi, Alhaji Musa.";

/** Each candidate: where it comes from, which file precision, and how it decodes. */
const CANDIDATES = [
  { name: "whisper tiny.en (shipped)", id: "onnx-community/whisper-tiny.en", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" } },
  { name: "whisper base.en", id: "onnx-community/whisper-base.en", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" } },
  { name: "whisper base.en q8", id: "onnx-community/whisper-base.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" } },
  { name: "whisper base.en + prompt", id: "onnx-community/whisper-base.en", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" }, prompt: true },
  { name: "whisper base.en beams 4", id: "onnx-community/whisper-base.en", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" }, beams: 4 },
  { name: "whisper base (multilingual, en)", id: "onnx-community/whisper-base", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" }, language: "english" },
  { name: "whisper small.en q8", id: "onnx-community/whisper-small.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" } },
  { name: "whisper small.en q8 + prompt", id: "onnx-community/whisper-small.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, prompt: true },
  { name: "distil small.en q8", id: "onnx-community/distil-small.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" } },
  { name: "moonshine tiny", id: "onnx-community/moonshine-tiny-ONNX", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" } },
  { name: "moonshine base", id: "onnx-community/moonshine-base-ONNX", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" } },
];
// Round 2 (ADR-041): the set-ups considered for shipping, with output capped to the length of the recording.
CANDIDATES.push(
  { name: "whisper base.en q8 + prompt + cap", id: "onnx-community/whisper-base.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, prompt: true, cap: true },
  { name: "whisper small.en q8 + prompt + cap", id: "onnx-community/whisper-small.en", dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, prompt: true, cap: true },
  { name: "moonshine base + cap", id: "onnx-community/moonshine-base-ONNX", dtype: { encoder_model: "fp32", decoder_model_merged: "q8" }, cap: true },
);
const only = process.env.VOICE_BENCH_ONLY ? new RegExp(process.env.VOICE_BENCH_ONLY, "i") : null;
const CROWD_DB = Number(process.env.VOICE_BENCH_CROWD_DB ?? 5);
/** About 8 tokens a second of speech, plus a little: enough for any sale said, not enough to run on and on. */
const capFor = (audio) => Math.min(440, Math.ceil((audio.length / 16000) * 8) + 16);

function readIndex(dir) {
  return readFileSync(join(dir, "index.tsv"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [file, text] = line.split("\t");
      return { file: join(dir, file), text };
    });
}

function decode(file) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

const rms = (audio) => Math.sqrt(audio.reduce((sum, value) => sum + value * value, 0) / Math.max(1, audio.length));

/** Other people talking at the same time, mixed in so speech is 5 dB louder than the crowd. */
function withCrowd(audio, others) {
  const crowd = new Float32Array(audio.length);
  for (const other of others) for (let index = 0; index < audio.length; index += 1) crowd[index] += other[index % other.length];
  const scale = rms(audio) / (rms(crowd) * 10 ** (CROWD_DB / 20) || 1);
  return audio.map((value, index) => value + crowd[index] * scale);
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (n >= size) return `${words(Math.floor(n / size))} ${name}${n % size ? ` ${words(n % size)}` : ""}`;
  }
  return String(n);
}
/** Lower case, numbers as words, no punctuation: so "75,000" and "seventy five thousand" count the same. */
function normalise(text) {
  return text
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/₦/g, " naira ")
    .replace(/\d+/g, (digits) => ` ${words(Number(digits))} `)
    .replace(/[-–]/g, " ")
    .replace(/[^a-z' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
function wordErrors(reference, hypothesis) {
  const ref = normalise(reference);
  const hyp = normalise(hypothesis);
  const row = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let i = 1; i <= ref.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return { errors: row[hyp.length], words: ref.length };
}

function keyOf(sale) {
  return JSON.stringify({
    lines: sale.lines.map((line) => [line.productText.split(" ").at(-1), String(line.quantity), String(line.unitPriceMinor), line.unit]),
    customer: (sale.customerText ?? "").toLowerCase().split(" ")[0] ?? "",
    paid: String(sale.paidMinor),
    total: String(sale.totalMinor),
  });
}

/**
 * How well the sale is read from what the model heard, against what the parser reads from the true words (ADR-044):
 * right (everything equal), quantities, money (prices, total, paid), products, failed (nothing usable or a blocking
 * question), and false confidence (looks complete, with no question for the trader, but is wrong).
 */
function saleScore(reference, hypothesis) {
  const want = parseSpokenSale(reference, { currency: "NGN" });
  const got = parseSpokenSale(hypothesis, { currency: "NGN" });
  const pairs = want.lines.map((line, index) => [line, got.lines[index]]);
  const blocking = new Set(["no_items", "no_quantity", "no_price", "unclear_price"]);
  const right = keyOf(want) === keyOf(got);
  return {
    right,
    quantity: pairs.length > 0 && pairs.every(([a, b]) => b && a.quantity === b.quantity),
    money: want.totalMinor === got.totalMinor && want.paidMinor === got.paidMinor && pairs.every(([a, b]) => b && a.unitPriceMinor === b.unitPriceMinor),
    product: pairs.length > 0 && pairs.every(([a, b]) => b && a.productText.split(" ").at(-1) === b.productText.split(" ").at(-1)),
    failed: got.lines.length === 0 || got.issues.some((issue) => blocking.has(issue.code ?? issue)),
    falseConfidence: !right && got.lines.length > 0 && got.issues.length === 0,
  };
}

function saleRight(reference, hypothesis) {
  return saleScore(reference, hypothesis).right;
}

async function modelBytes(id, dtype) {
  const response = await globalThis.fetch(`https://huggingface.co/api/models/${id}/tree/main/onnx`);
  if (!response.ok) return null;
  const files = await response.json();
  const suffix = { fp32: "", q8: "_quantized", fp16: "_fp16", q4: "_q4" };
  return Object.entries(dtype).reduce((sum, [part, precision]) => sum + (files.find((file) => file.path === `onnx/${part}${suffix[precision]}.onnx`)?.size ?? 0), 0);
}

async function transcriber(candidate) {
  const asr = await pipeline("automatic-speech-recognition", candidate.id, { dtype: candidate.dtype, device: "cpu" });
  if (!candidate.prompt) {
    return async (audio) =>
      (await asr(audio, { ...(candidate.language ? { language: candidate.language, task: "transcribe" } : {}), ...(candidate.beams ? { num_beams: candidate.beams } : {}), ...(candidate.cap ? { max_new_tokens: capFor(audio) } : {}) })).text;
  }
  // Whisper's prompt: earlier words before the start, so names and "naira" are expected (the library has no prompt option).
  const [startOfPrevious] = asr.tokenizer.convert_tokens_to_ids(["<|startofprev|>"]);
  const promptIds = asr.tokenizer.encode(` ${PROMPT}`, { add_special_tokens: false });
  const start = asr.model._retrieve_init_tokens(asr.model.generation_config);
  const init = [startOfPrevious, ...promptIds, ...start];
  return async (audio) => {
    const { input_features } = await asr.processor(audio);
    const output = await asr.model.generate({ inputs: input_features, decoder_input_ids: init, max_new_tokens: candidate.cap ? Math.min(440 - init.length, capFor(audio)) : 440 - init.length });
    const ids = Array.from(output.tolist()[0]).slice(init.length).map(Number);
    return asr.tokenizer.decode(ids, { skip_special_tokens: true });
  };
}

const sets = [
  { name: "Nigerian English (SLR70)", clips: readIndex(nigerianDir), sales: false },
  { name: "Spoken sales", clips: readIndex(salesDir), sales: true },
  ...(pidginDir ? [{ name: "Pidgin-influenced, fast and slow", clips: readIndex(pidginDir), sales: true }] : []),
];
for (const set of sets) {
  for (const clip of set.clips) clip.audio = decode(clip.file);
  set.clips.forEach((clip, index) => {
    const others = [1, 2, 3].map((step) => set.clips[(index + step * 7) % set.clips.length].audio);
    clip.crowd = withCrowd(clip.audio, others);
  });
}

const results = [];
for (const candidate of CANDIDATES) {
  if (only && !only.test(candidate.name)) continue;
  const row = { name: candidate.name, mb: null, error: null, scores: {} };
  try {
    row.mb = Math.round(((await modelBytes(candidate.id, candidate.dtype)) ?? 0) / 1e6);
    const read = await transcriber(candidate);
    await read(new Float32Array(16000));
    for (const set of sets) {
      for (const condition of ["audio", "crowd"]) {
        let errors = 0;
        let total = 0;
        let right = 0;
        const tally = { quantity: 0, money: 0, product: 0, failed: 0, falseConfidence: 0 };
        let seconds = 0;
        let audioSeconds = 0;
        const examples = [];
        for (const clip of set.clips) {
          const started = performance.now();
          const heard = await read(clip[condition]);
          seconds += (performance.now() - started) / 1000;
          audioSeconds += clip[condition].length / 16000;
          const counted = wordErrors(clip.text, heard);
          errors += counted.errors;
          total += counted.words;
          if (set.sales) {
            const score = saleScore(clip.text, heard);
            if (score.right) right += 1;
            for (const name of Object.keys(tally)) if (score[name]) tally[name] += 1;
          }
          if (examples.length < 3) examples.push(`${clip.text} → ${heard.trim()}`);
        }
        row.scores[`${set.name} ${condition === "audio" ? "clean" : "crowd"}`] = {
          wer: Math.round((errors / Math.max(1, total)) * 1000) / 10,
          ...(set.sales
            ? {
                salesRight: `${right}/${set.clips.length}`,
                ...Object.fromEntries(Object.entries(tally).map(([name, count]) => [name, Math.round((count / set.clips.length) * 1000) / 10])),
              }
            : {}),
          speed: Math.round((seconds / audioSeconds) * 100) / 100,
          examples,
        };
      }
    }
  } catch (failure) {
    row.error = String(failure?.message ?? failure).slice(0, 200);
  }
  results.push(row);
  console.log(JSON.stringify(row));
}

const columns = Object.keys(results.find((row) => !row.error)?.scores ?? {});
const table = [
  `| Model | Download (MB) | ${columns.map((column) => `${column} WER %`).join(" | ")} | Sales right (clean / crowd) | Seconds per second of audio |`,
  `| --- | --- | ${columns.map(() => "---").join(" | ")} | --- | --- |`,
  ...results.map((row) =>
    row.error
      ? `| ${row.name} | ${row.mb ?? ""} | ${columns.map(() => "").join(" | ")} | failed: ${row.error} | |`
      : `| ${row.name} | ${row.mb} | ${columns.map((column) => row.scores[column].wer).join(" | ")} | ${row.scores["Spoken sales clean"]?.salesRight ?? ""} / ${row.scores["Spoken sales crowd"]?.salesRight ?? ""} | ${row.scores[columns[0]].speed} |`,
  ),
].join("\n");
const salesColumns = columns.filter((column) => column.startsWith("Spoken sales") || column.startsWith("Pidgin"));
const extraction = [
  "| Model | Set | Sales right | Quantity right % | Money right % | Product right % | Failed (asked to correct) % | False confidence % |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results
    .filter((row) => !row.error)
    .flatMap((row) => salesColumns.map((column) => { const score = row.scores[column]; return `| ${row.name} | ${column} | ${score.salesRight} | ${score.quantity} | ${score.money} | ${score.product} | ${score.failed} | ${score.falseConfidence} |`; })),
].join("\n");
console.log(`\nVOICE BENCHMARK\n${table}\n\nSALE EXTRACTION\n${extraction}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Sale extraction\n\n${extraction}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Offline voice benchmark\n\n${table}\n`);
