#!/usr/bin/env node
// Offline voice assets (ADR-040), served from Bizora's own address so no third party is called at run time.
//
//   node scripts/voice-assets.mjs runtime          copy the ONNX Runtime WebAssembly files into public/voice/ort/<version>/
//   node scripts/voice-assets.mjs models [--allow-unlocked]
//                                                  download the speech model into public/voice/models/<version>/<id>/
//                                                  and check every file against src/lib/voice/models.lock.json
//
// "runtime" runs before every build. "models" runs in CI and in the Docker build, where the network allows it.
// --allow-unlocked records hashes for files the lock does not list yet (first download); without it a missing or
// different hash stops the build.
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const registry = JSON.parse(await readFile(join(app, "src/lib/voice/models.json"), "utf8"));
const lockPath = join(app, "src/lib/voice/models.lock.json");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runtime() {
  const require = createRequire(import.meta.url);
  const transformers = dirname(require.resolve("@huggingface/transformers"));
  // onnxruntime-web sits next to @huggingface/transformers in pnpm's store; walk up until it is found.
  let dir = transformers;
  let ort = null;
  for (let i = 0; i < 6 && !ort; i += 1) {
    const candidate = join(dir, "node_modules", "onnxruntime-web", "dist");
    const sibling = join(dir, "..", "onnxruntime-web", "dist");
    if (await exists(candidate)) ort = candidate;
    else if (await exists(sibling)) ort = sibling;
    dir = resolve(dir, "..");
  }
  if (!ort) throw new Error("onnxruntime-web was not found next to @huggingface/transformers.");
  const version = JSON.parse(await readFile(join(ort, "..", "package.json"), "utf8")).version;
  if (version !== registry.runtime.version) {
    throw new Error(`models.json lists onnxruntime-web ${registry.runtime.version} but ${version} is installed. Update models.json.`);
  }
  const target = join(app, "public", "voice", "ort", version);
  await mkdir(target, { recursive: true });
  for (const base of [registry.runtime.cpu, registry.runtime.gpu]) {
    for (const ext of [".wasm", ".mjs"]) await copyFile(join(ort, base + ext), join(target, base + ext));
  }
  console.log(`voice runtime ${version} copied to public/voice/ort/${version}`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function models(allowUnlocked) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.files ??= {};
  let changed = false;
  let total = 0;
  for (const model of registry.models) {
    const root = join(app, "public", "voice", "models", model.version, model.id);
    const files = [...model.files.map((file) => ({ file, optional: false })), ...(model.optionalFiles ?? []).map((file) => ({ file, optional: true }))];
    for (const { file, optional } of files) {
      const key = `${model.id}@${model.version}/${file}`;
      const path = join(root, file);
      const expected = lock.files[key]?.sha256;
      if (expected && (await exists(path)) && (await sha256(path)) === expected) {
        total += (await stat(path)).size;
        continue;
      }
      const url = `https://huggingface.co/${model.source}/resolve/${model.revision}/${file}`;
      const response = await globalThis.fetch(url);
      if (response.status === 404 && optional) continue;
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha256").update(body).digest("hex");
      if (expected && expected !== hash) throw new Error(`${key}: SHA-256 ${hash} does not match the lock (${expected}). Refusing a changed model file.`);
      if (!expected) {
        if (!allowUnlocked) throw new Error(`${key} is not in models.lock.json. Run with --allow-unlocked once, check the hashes, and commit the lock.`);
        lock.files[key] = { sha256: hash, bytes: body.length, commit: response.headers.get("x-repo-commit") ?? null };
        changed = true;
        console.log(`LOCK ${key} sha256=${hash} bytes=${body.length} commit=${response.headers.get("x-repo-commit") ?? "?"}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      total += body.length;
    }
    // The licence notice travels with the files this site serves.
    await writeFile(join(root, "NOTICE.txt"), `${model.id} ${model.version} from ${model.source}@${model.revision}\nLicence: ${model.license}\nRuntime: ${registry.runtime.package} ${registry.runtime.version} (${registry.runtime.license}); Transformers.js (Apache-2.0).\n`);
    // What the phone downloads, for the size shown before installing.
    await writeFile(join(root, "bizora-manifest.json"), JSON.stringify({ id: model.id, version: model.version, files: model.files, bytes: total }, null, 2));
  }
  if (changed) await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`voice models ready (${(total / 1_000_000).toFixed(1)} MB)`);
}

const [command, ...flags] = process.argv.slice(2);
if (command === "runtime") await runtime();
else if (command === "models") await models(flags.includes("--allow-unlocked"));
else {
  console.error("usage: voice-assets.mjs runtime | models [--allow-unlocked]");
  process.exit(2);
}
