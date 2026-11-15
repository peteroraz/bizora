import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hardcodedUiStrings } from "../../eslint-rules/scan-hardcoded-ui.mjs";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

describe("ui copy", () => {
  it("keeps component copy in the message catalog", () => {
    const offenders = files(src)
      .filter((file) => !file.includes(`${path.sep}design-preview${path.sep}`))
      .flatMap((file) => hardcodedUiStrings(readFileSync(file, "utf8"), file).map((hit) => `${path.relative(src, file)}:${hit.line} ${hit.text}`));
    expect(offenders).toEqual([]);
  });

  it("ignores catalog calls and flags visible text", () => {
    const flagged = hardcodedUiStrings("export function A(){ return <p>Hello there</p> }", "a.tsx");
    expect(flagged).toHaveLength(1);
    const clean = hardcodedUiStrings("export function A(){ const t = (key: string) => key; return <p>{t('Hello there')}</p> }", "a.tsx");
    expect(clean).toEqual([]);
  });
});
